// Unit tests for the faucet Lambda logic (no network, no AWS): exactly-once under parallel requests,
// crash recovery without double payment, rate limits, allowlist, and log hygiene.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Transaction, Wallet } from "ethers";
import { isValidParticipantId } from "../../src/real_ethereum/wallets/participantId.mjs";

const require = createRequire(import.meta.url);
const { createFaucetHandler, loadConfig, sha256, scrub, PID_PATTERN } = require("../../infrastructure/faucet/handler.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { generatePids, uploadPids } = require("./pidTools.js");

const AMOUNT = 10n ** 17n;
const GAS_PRICE = 100n * 10n ** 9n;
const PAID_GAS_PRICE = (GAS_PRICE * 12n) / 10n; // the handler adds 20% headroom
const CONFIG = { chainId: 23293, amountWei: AMOUNT, rateLimit: 1000, globalRateLimit: 10000, rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 1000, absentChecks: 3, absentDelayMs: 0 };
const faucetKey = Wallet.createRandom().privateKey; // disposable, never printed

const fakeChain = ({ balance = 10n ** 20n } = {}) => {
  const sent = [];
  const mined = new Map();
  const state = { balance, nonce: 0, failNextSend: false, revertNext: false, hideCalls: 0, nonceTooLowOnResend: false };
  const failed = new Set();
  return {
    sent, mined, state,
    getBalance: async () => state.balance,
    getNonce: async () => state.nonce,
    getGasPrice: async () => GAS_PRICE,
    sendRaw: async (raw) => {
      sent.push(raw);
      if (state.failNextSend) { state.failNextSend = false; throw new Error("network down"); }
      const tx = Transaction.from(raw);
      if (mined.has(tx.hash)) {
        if (state.nonceTooLowOnResend) throw new Error("nonce too low");
        return;
      }
      mined.set(tx.hash, tx);
      state.nonce += 1;
      state.balance -= tx.value + PAID_GAS_PRICE * 21000n;
      if (state.revertNext) { state.revertNext = false; failed.add(tx.hash); }
    },
    getReceipt: async (hash) => (mined.has(hash) ? { status: failed.has(hash) ? 0 : 1 } : null),
    getTransaction: async (hash) => {
      if (state.hideCalls > 0) { state.hideCalls -= 1; return null; } // an RPC node that lags behind
      return mined.get(hash) || null;
    },
  };
};

const setup = async (overrides = {}) => {
  const store = createMemoryStore();
  const chain = overrides.chain || fakeChain();
  const logs = [];
  const clock = { ms: 1_700_000_000_000 };
  const handler = createFaucetHandler({
    store, chain, config: { ...CONFIG, ...overrides.config },
    getPrivateKey: overrides.getPrivateKey || (async () => faucetKey),
    now: () => clock.ms, log: (line) => logs.push(line),
  });
  const pids = generatePids(6);
  await uploadPids(store, pids);
  const claim = (pid, address, ip = "203.0.113.7") => handler({
    body: JSON.stringify({ pid, address }), requestContext: { http: { method: "POST", sourceIp: ip } },
  });
  return { store, chain, logs, clock, handler, pids, claim };
};
const addr = () => Wallet.createRandom().address;
const parse = (response) => JSON.parse(response.body);

test("a pid is paid exactly once, even with parallel requests", async () => {
  const { claim, chain, pids } = await setup();
  const to = addr();
  const responses = await Promise.all(Array.from({ length: 20 }, () => claim(pids[0], to)));
  const paid = responses.filter((r) => r.statusCode === 200 && parse(r).status === "paid");
  assert.equal(paid.length, 1, "exactly one request pays");
  for (const r of responses) assert.ok([200, 409].includes(r.statusCode), `unexpected ${r.statusCode}`);
  assert.equal(chain.sent.length, 1, "one transaction on chain");
  assert.equal(Transaction.from(chain.sent[0]).value, AMOUNT);
  assert.equal(Transaction.from(chain.sent[0]).to, to);
  // A later retry with the same address is idempotent (same hash, no new payment); another address is refused.
  const again = await claim(pids[0], to);
  assert.equal(parse(again).status, "already_paid");
  assert.equal(parse(again).txHash, parse(paid[0]).txHash);
  assert.equal((await claim(pids[0], addr())).statusCode, 403);
  assert.equal(chain.sent.length, 1);
});

test("parallel claims for different pids all pay once with distinct nonces", async () => {
  const { claim, chain, pids } = await setup();
  const responses = await Promise.all(pids.slice(0, 5).map((pid) => claim(pid, addr())));
  assert.deepEqual(responses.map((r) => r.statusCode), [200, 200, 200, 200, 200]);
  const nonces = chain.sent.map((raw) => Transaction.from(raw).nonce).sort((a, b) => a - b);
  assert.deepEqual(nonces, [0, 1, 2, 3, 4]);
});

test("unknown pids, bad input, wrong method and oversized bodies are rejected", async () => {
  const { claim, handler, chain } = await setup();
  assert.equal((await claim("ABCDEFGH2345XYZ9", addr())).statusCode, 403, "valid format but not on the allowlist");
  assert.equal((await claim("a@b.com", addr())).statusCode, 400);
  assert.equal((await claim("ABCDEFGH2345XYZ9", "0x12")).statusCode, 400);
  assert.equal((await handler({ body: "{", requestContext: { http: { method: "POST" } } })).statusCode, 400);
  assert.equal((await handler({ body: "{}", requestContext: { http: { method: "GET" } } })).statusCode, 405);
  assert.equal((await handler({ body: "x".repeat(3000), requestContext: { http: { method: "POST" } } })).statusCode, 413);
  assert.equal(chain.sent.length, 0);
});

test("rate limit per caller and global, evaluated before the pid lookup", async () => {
  const { claim } = await setup({ config: { rateLimit: 3 } });
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push((await claim("ZZZZZZZZ9999", addr(), "198.51.100.1")).statusCode);
  assert.deepEqual(results, [403, 403, 403, 429, 429], "guessing codes is throttled");
  assert.notEqual((await claim("ZZZZZZZZ9999", addr(), "198.51.100.2")).statusCode, 429, "another caller is unaffected");
  const global = await setup({ config: { globalRateLimit: 2 } });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await global.claim("ZZZZZZZZ9999", addr(), `192.0.2.${i}`)).statusCode);
  assert.deepEqual(statuses, [403, 403, 429, 429]);
});

test("a crash after signing never pays twice: the retry re-broadcasts the SAME transaction", async () => {
  const { claim, chain, clock, pids, store } = await setup();
  const to = addr();
  chain.state.failNextSend = true;
  assert.equal((await claim(pids[1], to)).statusCode, 500, "broadcast failed");
  assert.equal(chain.mined.size, 0);
  assert.equal((await claim(pids[1], to)).statusCode, 409, "lease still held");
  clock.ms += 120_000; // lease expired
  const retry = await claim(pids[1], to);
  assert.equal(retry.statusCode, 200);
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.sent[0], chain.sent[1], "identical raw transaction");
  assert.equal(chain.mined.size, 1, "paid once");
  assert.equal((await store.get(sha256(pids[1]))).status, "paid");
  assert.equal((await store.get(sha256(pids[1]))).rawTx, undefined, "raw tx removed after payment");
});

test("a reverted payment releases the pid instead of wedging it", async () => {
  const { claim, chain, pids, store } = await setup();
  chain.state.revertNext = true;
  const first = await claim(pids[3], addr());
  assert.equal(first.statusCode, 422);
  assert.equal(parse(first).error, "transfer_failed");
  assert.equal((await store.get(sha256(pids[3]))).status, "unclaimed");
  const retry = await claim(pids[3], addr());
  assert.equal(retry.statusCode, 200, "the code works again with a normal address");
});

test("a stale pending reservation cannot be hijacked or re-pointed by another address", async () => {
  const { claim, chain, clock, pids, store } = await setup();
  const original = addr();
  chain.state.failNextSend = true;
  assert.equal((await claim(pids[4], original)).statusCode, 500);
  clock.ms += 120_000; // lease expired
  assert.equal((await claim(pids[4], addr())).statusCode, 403, "another address is refused");
  assert.equal((await store.get(sha256(pids[4]))).address, original.toLowerCase(), "stored address is unchanged");
  assert.equal((await claim(pids[4], original)).statusCode, 200, "the original address completes the payment");
  assert.equal(Transaction.from(chain.sent[chain.sent.length - 1]).to, original);
  assert.equal(chain.mined.size, 1);
  assert.equal((await claim(pids[4], original)).statusCode, 200, "and a repeat is idempotent");
  assert.equal(chain.mined.size, 1);
});

test("an RPC that lags (nonce too low, transaction not yet visible) never causes a second payment", async () => {
  const { claim, chain, clock, pids } = await setup();
  const to = addr();
  chain.state.failNextSend = true;
  assert.equal((await claim(pids[5], to)).statusCode, 500); // signed, stored, broadcast reported failure
  // In reality the transaction did get mined; our RPC node just does not show it yet.
  await chain.sendRaw(chain.sent[0]);
  chain.state.nonceTooLowOnResend = true;
  chain.state.hideCalls = 2;
  clock.ms += 120_000;
  const lagging = await claim(pids[5], to);
  assert.equal(lagging.statusCode, 202, "unclear state: ask the client to retry");
  assert.equal(chain.mined.size, 1, "no second transaction was signed");
  clock.ms += 120_000;
  const settled = await claim(pids[5], to);
  assert.equal(settled.statusCode, 200);
  assert.equal(chain.mined.size, 1);
  assert.equal(new Set(chain.sent).size, 1, "only one distinct signed transaction ever existed");
});

test("if recording the payment fails after it is confirmed, the retry only confirms and records it", async () => {
  const { claim, chain, clock, pids, store } = await setup();
  const to = addr();
  const markPaid = store.markPaid;
  store.markPaid = async () => { throw new Error("dynamodb unavailable"); };
  assert.equal((await claim(pids[0], to)).statusCode, 500);
  store.markPaid = markPaid;
  assert.equal(chain.mined.size, 1);
  clock.ms += 120_000;
  const retry = await claim(pids[0], to);
  assert.equal(retry.statusCode, 200);
  assert.equal(chain.sent.length, 1, "no re-broadcast, no second payment");
  assert.equal((await store.get(sha256(pids[0]))).status, "paid");
});

test("error text is scrubbed of hex before it is logged", () => {
  const raw = `0x${"ab".repeat(120)}`;
  assert.equal(scrub(`failed ${raw} and ${"c".repeat(64)}`).includes("ab".repeat(10)), false);
  assert.ok(scrub("x".repeat(500)).length <= 200);
});

test("an empty faucet answers 503 and the pid stays usable", async () => {
  const chain = fakeChain({ balance: 1n });
  const { claim, pids } = await setup({ chain });
  assert.equal((await claim(pids[2], addr())).statusCode, 503);
  chain.state.balance = 10n ** 20n;
  assert.equal((await claim(pids[2], addr())).statusCode, 200);
});

test("logs never contain the key, raw transactions, pids, addresses or IPs", async () => {
  const secretLeak = `${faucetKey}`;
  const failing = await setup({ getPrivateKey: async () => { throw new Error(`boom ${secretLeak}`); } });
  const ip = "203.0.113.99";
  const to = addr();
  assert.equal((await failing.claim(failing.pids[0], to, ip)).statusCode, 500);
  const ok = await setup();
  const okTo = addr();
  const paid = await ok.claim(ok.pids[0], okTo, ip);
  assert.equal(paid.statusCode, 200);
  const everything = [...failing.logs, ...ok.logs].join("\n").toLowerCase();
  const forbidden = [faucetKey.slice(2), ok.chain.sent[0].slice(2), ok.pids[0], failing.pids[0], to, okTo, ip].map((s) => s.toLowerCase());
  for (const secret of forbidden) assert.equal(everything.includes(secret), false, `log leaks ${secret.slice(0, 8)}...`);
  assert.ok(failing.logs.length > 0 && ok.logs.length > 0, "events are still logged");
});

test("config refuses mainnet and a zero amount; pid format matches the app", () => {
  assert.throws(() => loadConfig({ CHAIN_ID: "23294", FAUCET_AMOUNT_WEI: "1" }), /Sapphire testnet or localnet/);
  assert.throws(() => loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "0" }), /positive/);
  assert.equal(loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5" }).amountWei, 5n);
  for (const sample of ["K7f3QpX9mA2d", "a@b.com", "0501234567", "12345678", "short1", "has space abc", "ABCDEFGH", "a".repeat(40), ""]) {
    assert.equal(PID_PATTERN.test(sample), isValidParticipantId(sample), sample);
  }
});

test("generated codes are unique, valid, and only digests are uploaded", async () => {
  const pids = generatePids(500);
  assert.equal(new Set(pids).size, 500);
  assert.ok(pids.every((pid) => isValidParticipantId(pid) && pid.length === 16));
  const store = createMemoryStore();
  assert.equal(await uploadPids(store, pids), 500);
  assert.equal(await uploadPids(store, pids), 0, "re-upload never overwrites");
  for (const pid of pids.slice(0, 20)) {
    assert.equal(store.pids.has(pid), false, "raw code must not be a key");
    assert.equal(store.pids.has(sha256(pid)), true);
  }
});
