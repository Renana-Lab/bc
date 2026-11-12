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
    getAdminSecret: overrides.getAdminSecret,
    getPrivateKey: overrides.getPrivateKey || (async () => faucetKey),
    getRateSalt: overrides.getRateSalt || (async () => "test-salt-one"),
    now: () => clock.ms, log: (line) => logs.push(line),
  });
  const pids = generatePids(6);
  await uploadPids(store, pids);
  if (!overrides.closed) await store.setState(true, 1_700_000_000); // the faucet is closed by default
  const claim = (pid, address, ip = "203.0.113.7", extra = {}) => handler({
    body: JSON.stringify({ pid, address, ...extra }), requestContext: { http: { method: "POST", sourceIp: ip } },
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

test("rate-limit records: salted per-window HMAC, short TTL, never joined with participant codes", async () => {
  const { claim, store, pids, clock } = await setup();
  const ip = "203.0.113.77";
  const to = addr();
  await claim(pids[0], to, ip);
  const nowSeconds = Math.floor(clock.ms / 1000);
  const windowEnd = (Math.floor(nowSeconds / 600) + 1) * 600;
  const recordsJson = JSON.stringify([...store.counters]);
  // 1. No raw IP, and not the unsalted hash either (an IPv4 hash without a secret salt could be brute-forced).
  assert.equal(recordsJson.includes(ip), false);
  assert.equal(recordsJson.includes(sha256(`ip:${ip}`).slice(0, 32)), false);
  // 2. Short TTL: expires at the end of its window plus a minute, never days.
  for (const [, record] of store.counters) {
    assert.ok(record.expiresAt > nowSeconds && record.expiresAt <= windowEnd + 60, `ttl ${record.expiresAt - nowSeconds}s`);
  }
  assert.ok([...store.counters.keys()].length >= 2, "caller and global counters exist");
  // 3. No join: rate records hold nothing about the code, and code records hold nothing about the caller.
  for (const pid of pids) {
    assert.equal(recordsJson.includes(pid) || recordsJson.includes(sha256(pid)), false);
  }
  const pidJson = JSON.stringify([...store.pids]);
  for (const key of store.counters.keys()) assert.equal(pidJson.includes(key.split("#")[0].replace("ip:", "")), false);
  assert.equal(/ip|caller|sourceIp/i.test(Object.keys([...store.pids.values()][0]).join(",")), false);
  // 4. Unlinkable across windows and across salts: same IP, different window/salt -> different key.
  const keyAt = async (salt, secondsLater) => {
    const t = await setup({ getRateSalt: async () => salt });
    t.clock.ms += secondsLater * 1000;
    await t.claim(t.pids[0], addr(), ip);
    return [...t.store.counters.keys()].find((k) => k.startsWith("ip:"));
  };
  const base = await keyAt("salt-A", 0);
  assert.notEqual(await keyAt("salt-A", 700), base, "a different window gives a different record key");
  assert.notEqual(await keyAt("salt-B", 0), base, "a different salt gives a different record key");
  assert.equal(await keyAt("salt-A", 0), base, "same salt and window: same key (counting works)");
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

// ---------------------------------------------------------------------------------------------
// Prolific pid mode, payout cap, open/closed switch and admin password
// ---------------------------------------------------------------------------------------------
const { hashPassword } = require("../../infrastructure/faucet/adminAuth.js");
const PROLIFIC = { pidMode: "prolific", maxPayouts: 3 };
const hex24 = () => Wallet.createRandom().privateKey.slice(2, 26); // random 24-hex id
const call = (handler, path, method, payload, ip = "203.0.113.50") => handler({
  rawPath: path, body: payload === undefined ? undefined : JSON.stringify(payload), requestContext: { http: { method, sourceIp: ip } },
});

test("allowlist mode (default): unknown pid is still 403 not_eligible and 24-hex ids get no special treatment", async () => {
  const { claim, store, chain } = await setup();
  const res = await claim(hex24(), addr());
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).error, "not_eligible");
  assert.equal(store.pids.size, 6, "nothing was inserted");
  assert.equal(chain.sent.length, 0);
  assert.equal(loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5" }).pidMode, "allowlist");
});

test("prolific: a fresh 24-hex id is paid once; same-address retries are already_paid; another address is 403", async () => {
  const { claim, chain, store } = await setup({ config: PROLIFIC });
  const pid = hex24();
  const to = addr();
  const first = await claim(pid, to);
  assert.equal(first.statusCode, 200);
  assert.equal(parse(first).status, "paid");
  const again = await claim(pid, to);
  assert.equal(parse(again).status, "already_paid");
  assert.equal(parse(again).txHash, parse(first).txHash);
  assert.equal((await claim(pid, addr())).statusCode, 403);
  assert.equal((await claim(pid.toUpperCase(), addr())).statusCode, 403, "case variants are the same participant");
  assert.equal(parse(await claim(pid.toUpperCase(), to)).status, "already_paid");
  assert.equal(chain.sent.length, 1);
  assert.equal(store.pids.has(sha256(pid)), true, "stored under the sha256 key");
  assert.equal(store.pids.has(pid), false);
});

test("prolific: invalid formats are 400 (lab codes and short/long/non-hex ids are not accepted)", async () => {
  const { claim, pids, chain } = await setup({ config: PROLIFIC });
  for (const bad of [pids[0], "a".repeat(23), "a".repeat(25), `${"a".repeat(23)}g`, "", "a@b.com", `${"a".repeat(23)} `]) {
    assert.equal((await claim(bad, addr())).statusCode, 400, bad);
  }
  assert.equal((await claim(hex24(), "0x12")).statusCode, 400);
  assert.equal(chain.sent.length, 0);
});

test("prolific: FAUCET_MAX_PAYOUTS is required (fails closed)", async () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "abc"]) {
    assert.throws(() => loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5", FAUCET_PID_MODE: "prolific", FAUCET_MAX_PAYOUTS: value }), /FAUCET_MAX_PAYOUTS/, String(value));
  }
  assert.equal(loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5", FAUCET_PID_MODE: "prolific", FAUCET_MAX_PAYOUTS: "40" }).maxPayouts, 40);
  assert.throws(() => loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5", FAUCET_PID_MODE: "bogus" }), /FAUCET_PID_MODE/);
  assert.throws(() => createFaucetHandler({ store: createMemoryStore(), chain: fakeChain(), config: { ...CONFIG, pidMode: "prolific" } }), /FAUCET_MAX_PAYOUTS/);
});

test("prolific: the payout cap is enforced with a distinct 403; paid ids are still served; a release gives the slot back", async () => {
  const { claim, chain, store } = await setup({ config: { ...PROLIFIC, maxPayouts: 2 } });
  const first = { pid: hex24(), to: addr() };
  assert.equal((await claim(first.pid, first.to)).statusCode, 200);
  assert.equal((await claim(hex24(), addr())).statusCode, 200);
  const over = await claim(hex24(), addr());
  assert.equal(over.statusCode, 403);
  assert.equal(parse(over).error, "budget_exhausted");
  assert.equal(chain.sent.length, 2);
  assert.equal(parse(await claim(first.pid, first.to)).status, "already_paid", "retry after the cap still works");
  assert.equal(store.shared.budget, 2);
  // A reverted transfer releases its reservation and must not consume a slot.
  const t = await setup({ config: { ...PROLIFIC, maxPayouts: 1 } });
  t.chain.state.revertNext = true;
  const reverted = hex24();
  assert.equal((await t.claim(reverted, addr())).statusCode, 422);
  assert.equal(t.store.shared.budget, 0, "released reservation holds no slot");
  assert.equal((await t.claim(reverted, addr())).statusCode, 200, "the slot was free for the retry");
  assert.equal(t.store.shared.budget, 1);
  // An empty faucet also releases the slot.
  const e = await setup({ chain: fakeChain({ balance: 1n }), config: { ...PROLIFIC, maxPayouts: 1 } });
  assert.equal((await e.claim(hex24(), addr())).statusCode, 503);
  assert.equal(e.store.shared.budget, 0);
});

test("prolific: parallel claims never exceed the cap", async () => {
  const { claim, chain, store } = await setup({ config: { ...PROLIFIC, maxPayouts: 3 } });
  const results = await Promise.all(Array.from({ length: 10 }, () => claim(hex24(), addr())));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 3);
  assert.equal(results.filter((r) => r.statusCode === 403 && parse(r).error === "budget_exhausted").length, 7);
  assert.equal(chain.sent.length, 3);
  assert.equal(store.shared.budget, 3);
});

test("prolific: studyId and experimentCode must match when configured (checked before anything is reserved)", async () => {
  const cfg = { ...PROLIFIC, requiredStudyId: "study-ABC123", experimentCode: "shared-code-xyz" };
  const { claim, chain, store, logs } = await setup({ config: cfg });
  const to = addr();
  const pid = hex24();
  for (const extra of [{}, { studyId: "study-ABC123" }, { experimentCode: "shared-code-xyz" }, { studyId: "wrong", experimentCode: "shared-code-xyz" }, { studyId: "study-ABC123", experimentCode: "nope" }]) {
    const res = await claim(pid, to, "203.0.113.7", extra);
    assert.equal(res.statusCode, 403, JSON.stringify(extra));
    assert.equal(parse(res).error, "not_eligible");
  }
  assert.equal((await claim(pid, to, "203.0.113.7", { studyId: 5, experimentCode: "shared-code-xyz" })).statusCode, 400);
  assert.equal(store.pids.has(sha256(pid)), false, "nothing was reserved or inserted");
  assert.equal(chain.sent.length, 0);
  assert.equal((await claim(pid, to, "203.0.113.7", { studyId: "study-ABC123", experimentCode: "shared-code-xyz" })).statusCode, 200);
  const everything = logs.join("\n");
  assert.equal(everything.includes("shared-code-xyz") || everything.includes("nope") || everything.includes("study-ABC123"), false, "codes are never logged");
  // Only the configured checks apply.
  const onlyStudy = await setup({ config: { ...PROLIFIC, requiredStudyId: "S1" } });
  assert.equal((await onlyStudy.claim(hex24(), addr(), "203.0.113.7", { studyId: "S1" })).statusCode, 200);
});

test("prolific: two parallel first claims for the same new id pay only once", async () => {
  const { claim, chain, store } = await setup({ config: PROLIFIC });
  const pid = hex24();
  const to = addr();
  const results = await Promise.all([claim(pid, to), claim(pid, to), claim(pid, to)]);
  assert.equal(results.filter((r) => r.statusCode === 200 && parse(r).status === "paid").length, 1);
  for (const r of results) assert.ok([200, 409].includes(r.statusCode), `unexpected ${r.statusCode}`);
  assert.equal(chain.sent.length, 1);
  assert.equal(store.shared.budget, 1, "one slot for one payment");
});

// ---------------------------------------------------------------------------------------------
// Open pid mode: any trimmed printable-ASCII id of 1-128 characters, case-sensitive, paid once, capped
// ---------------------------------------------------------------------------------------------
const OPEN = { pidMode: "open", maxPayouts: 3 };

test("open: a non-hex pid is accepted, paid once, and used case-sensitively as the payout key", async () => {
  const { claim, chain, store } = await setup({ config: OPEN });
  const to = addr();
  const first = await claim("Participant_42!", to);
  assert.equal(first.statusCode, 200);
  assert.equal(parse(first).status, "paid");
  const again = await claim("Participant_42!", to);
  assert.equal(parse(again).status, "already_paid");
  assert.equal(parse(again).txHash, parse(first).txHash);
  assert.equal((await claim("Participant_42!", addr())).statusCode, 403, "another wallet cannot reuse the pid");
  assert.equal(chain.sent.length, 1, "paid exactly once");
  assert.equal(store.pids.has(sha256("Participant_42!")), true, "stored under the sha256 of the exact string");
  assert.equal(store.pids.has("Participant_42!"), false, "the raw pid is never stored");
  // Case-sensitive: a different case is a different participant and is paid separately (NOT lowercased).
  assert.equal(store.pids.has(sha256("participant_42!")), false);
  const lower = await claim("participant_42!", addr());
  assert.equal(lower.statusCode, 200);
  assert.equal(store.pids.has(sha256("participant_42!")), true);
  assert.equal(chain.sent.length, 2);
});

test("open: surrounding whitespace is trimmed (same payout key), inner whitespace is rejected", async () => {
  const { claim, chain } = await setup({ config: OPEN });
  const to = addr();
  assert.equal((await claim("  abc-1  ", to)).statusCode, 200);
  assert.equal(parse(await claim("abc-1", to)).status, "already_paid");
  assert.equal(parse(await claim("\tabc-1\n", to)).status, "already_paid");
  assert.equal(chain.sent.length, 1);
  for (const bad of ["a b", "a\tb", "a\nb"]) assert.equal((await claim(bad, addr())).statusCode, 400, JSON.stringify(bad));
});

test("open: empty, too long, control-character and non-ASCII pids are 400 and nothing is reserved or paid", async () => {
  const { claim, chain, store } = await setup({ config: OPEN });
  const before = store.pids.size;
  const bad = ["", "   ", "x".repeat(129), `a${String.fromCharCode(0)}b`, "a\u0007b", "a\u007fb", "café", "שלום", "a​b", 12345, null, {}, ["a"]];
  for (const pid of bad) assert.equal((await claim(pid, addr())).statusCode, 400, JSON.stringify(pid));
  assert.equal((await claim("ok", "0x12")).statusCode, 400);
  assert.equal(chain.sent.length, 0);
  assert.equal(store.pids.size, before, "nothing inserted");
  assert.equal(store.shared.budget ?? 0, 0, "no payout slot taken");
  // Boundaries are accepted.
  assert.equal((await claim("x", addr())).statusCode, 200);
  assert.equal((await claim("y".repeat(128), addr())).statusCode, 200);
  assert.equal((await claim("!~", addr())).statusCode, 200);
});

test("open: FAUCET_MAX_PAYOUTS is required (fails closed) and the cap is enforced", async () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "abc"]) {
    assert.throws(() => loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5", FAUCET_PID_MODE: "open", FAUCET_MAX_PAYOUTS: value }), /FAUCET_MAX_PAYOUTS/, String(value));
  }
  const cfg = loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5", FAUCET_PID_MODE: "OPEN", FAUCET_MAX_PAYOUTS: "40" });
  assert.deepEqual([cfg.pidMode, cfg.maxPayouts], ["open", 40]);
  assert.throws(() => createFaucetHandler({ store: createMemoryStore(), chain: fakeChain(), config: { ...CONFIG, pidMode: "open" } }), /FAUCET_MAX_PAYOUTS/);

  const { claim, chain, store } = await setup({ config: { ...OPEN, maxPayouts: 2 } });
  const first = { pid: "alpha", to: addr() };
  assert.equal((await claim(first.pid, first.to)).statusCode, 200);
  assert.equal((await claim("beta", addr())).statusCode, 200);
  const over = await claim("gamma", addr());
  assert.equal(over.statusCode, 403);
  assert.equal(parse(over).error, "budget_exhausted");
  assert.equal(chain.sent.length, 2);
  assert.equal(parse(await claim(first.pid, first.to)).status, "already_paid", "already paid pids are still served at the cap");
  assert.equal(store.shared.budget, 2);
});

test("open: parallel claims never exceed the cap and the same pid is paid once", async () => {
  const { claim, chain, store } = await setup({ config: { ...OPEN, maxPayouts: 3 } });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`pid-${i}`, addr())));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 3);
  assert.equal(chain.sent.length, 3);
  assert.equal(store.shared.budget, 3);
  const same = await setup({ config: OPEN });
  const to = addr();
  const dup = await Promise.all([same.claim("dup!", to), same.claim("dup!", to), same.claim("dup!", to)]);
  assert.equal(dup.filter((r) => r.statusCode === 200 && parse(r).status === "paid").length, 1);
  assert.equal(same.chain.sent.length, 1);
});

test("open: the admin switch, study and experiment checks, and /status pidMode still apply", async () => {
  const closed = await setup({ closed: true, config: OPEN });
  const refused = await closed.claim("someone", addr());
  assert.equal(parse(refused).error, "faucet_closed");
  assert.equal(closed.chain.sent.length, 0);
  assert.equal(closed.store.shared.budget ?? 0, 0);
  assert.equal(parse(await call(closed.handler, "/status", "GET")).pidMode, "open");

  const t = await setup({ config: { ...OPEN, requiredStudyId: "S1", experimentCode: "EXP" } });
  assert.equal(parse(await t.claim("someone", addr())).error, "not_eligible");
  assert.equal(parse(await t.claim("someone", addr(), "203.0.113.7", { studyId: "S2", experimentCode: "EXP" })).error, "not_eligible");
  assert.equal(t.chain.sent.length, 0);
  assert.equal((await t.claim("someone", addr(), "203.0.113.7", { studyId: "S1", experimentCode: "EXP" })).statusCode, 200);
});

test("open: logs never contain the raw pid", async () => {
  const { claim, logs } = await setup({ config: OPEN });
  await claim("secret-looking-pid", addr());
  await claim("secret-looking-pid", addr());
  assert.equal(logs.join("\n").includes("secret-looking-pid"), false);
});

test("prolific and allowlist modes are unchanged by open mode", async () => {
  const { claim, store } = await setup({ config: PROLIFIC });
  for (const pid of ["Participant_42!", "abc", "z".repeat(24)]) assert.equal((await claim(pid, addr())).statusCode, 400, pid);
  const id = hex24();
  assert.equal((await claim(id.toUpperCase(), addr())).statusCode, 200);
  assert.equal(store.pids.has(sha256(id)), true, "folded to lowercase before hashing");
  assert.equal(parse(await call((await setup({ config: PROLIFIC })).handler, "/status", "GET")).pidMode, "prolific");
  const allow = await setup();
  assert.equal(parse(await allow.claim("Participant_42!", addr())).error, "bad_request", "an invented pid is not valid in allowlist mode");
});

test("switch: closed by default (missing or unreadable state), claims refused before reserve, in both modes", async () => {
  for (const config of [undefined, PROLIFIC]) {
    const { claim, pids, chain, store } = await setup({ closed: true, config });
    const pid = config ? hex24() : pids[0];
    const res = await claim(pid, addr());
    assert.equal(res.statusCode, 403);
    assert.equal(parse(res).error, "faucet_closed");
    assert.equal(store.pids.has(sha256(pid)) ? store.pids.get(sha256(pid)).status : "unclaimed", "unclaimed", "no reservation was made");
    assert.equal(chain.sent.length, 0);
    const getState = store.getState;
    store.getState = async () => { throw new Error("dynamodb unavailable"); };
    assert.equal(parse(await claim(pid, addr())).error, "faucet_closed", "unreadable state is closed");
    store.getState = getState;
    await store.setState(false, 5);
    assert.equal(parse(await claim(pid, addr())).error, "faucet_closed");
  }
});

test("switch: /status is public and returns only open, updatedAt and pidMode", async () => {
  const { handler, store } = await setup({ closed: true });
  const closed = await call(handler, "/status", "GET");
  assert.equal(closed.statusCode, 200);
  assert.deepEqual(parse(closed), { open: false, updatedAt: null, pidMode: "allowlist" });
  await store.setState(true, 1_700_000_000);
  const open = parse(await call(handler, "/status", "GET"));
  assert.deepEqual(Object.keys(open).sort(), ["open", "pidMode", "updatedAt"]);
  assert.equal(open.open, true);
  assert.equal(open.updatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal((await call(handler, "/status", "POST", {})).statusCode, 405);
  assert.equal((await call(handler, "/nope", "GET")).statusCode, 404);
});

const adminSetup = async (overrides = {}) => {
  const password = "correct horse battery staple";
  const record = await hashPassword(password);
  const t = await setup({ closed: true, getAdminSecret: async () => record, ...overrides });
  const admin = (open, pw = password, ip = "198.51.100.9") => call(t.handler, "/admin/state", "POST", { open, password: pw }, ip);
  return { ...t, admin, password };
};

test("switch: admin opens and closes with the right password; wrong password is 401 without detail; claims follow the state", async () => {
  const { admin, claim, pids, store } = await adminSetup();
  const wrong = await admin(true, "not the password");
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(parse(wrong), { error: "unauthorized" });
  assert.equal(await store.getState(), null, "a wrong password changes nothing");
  assert.equal((await claim(pids[0], addr())).statusCode, 403);
  const opened = await admin(true);
  assert.equal(opened.statusCode, 200);
  assert.equal(parse(opened).open, true);
  assert.equal((await claim(pids[0], addr())).statusCode, 200);
  const closed = await admin(false);
  assert.equal(parse(closed).open, false);
  assert.equal(parse(await claim(pids[1], addr())).error, "faucet_closed");
  assert.equal((await admin(undefined)).statusCode, 400, "right password but no boolean");
});

test("switch: without a configured admin secret nobody can change the state (401)", async () => {
  const { admin } = await adminSetup({ getAdminSecret: async () => null });
  assert.equal((await admin(true)).statusCode, 401);
  const failing = await adminSetup({ getAdminSecret: async () => { throw new Error("secrets unavailable"); } });
  assert.equal((await failing.admin(true)).statusCode, 401);
});

test("switch: admin attempts are rate limited per caller (5 per window, then 429) and globally", async () => {
  const { admin } = await adminSetup();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await admin(true, "wrong password", "198.51.100.1")).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
  assert.equal((await admin(true, "correct horse battery staple", "198.51.100.1")).statusCode, 429, "even the right password is refused once limited");
  assert.equal((await admin(true, "wrong password", "198.51.100.2")).statusCode, 401, "another caller is unaffected");
  const g = await adminSetup({ config: { adminGlobalRateLimit: 3 } });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await g.admin(true, "wrong password", `192.0.2.${i}`)).statusCode);
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test("switch: the admin password never appears in logs, responses or stored records", async () => {
  const { admin, logs, store, password } = await adminSetup();
  const guess = "super secret guess 123";
  const responses = [await admin(true, guess), await admin(true), await admin(false)];
  const everything = [...logs, ...responses.map((r) => r.body), JSON.stringify([...store.counters]), JSON.stringify(store.shared)].join("\n");
  for (const secret of [guess, password]) assert.equal(everything.includes(secret), false, "password leaked");
  assert.ok(logs.length > 0);
});

// ---------------------------------------------------------------------------------------------
// Review fixes: failed-only admin limiter, /64 keys, secret TTL, closed pass-through
// ---------------------------------------------------------------------------------------------
const { normalizeIp } = require("../../infrastructure/faucet/handler.js");

test("admin limiter: 100 wrong passwords from several IPs do not block the right password from a new IP", async () => {
  const { admin, store } = await adminSetup();
  for (let i = 0; i < 100; i += 1) {
    const res = await admin(true, `wrong password ${i}`, `198.51.100.${(i % 25) + 1}`);
    assert.equal(res.statusCode, 401, `attempt ${i}`); // 4 failures per IP: under the per-caller limit
  }
  const ok = await admin(true, "correct horse battery staple", "203.0.113.200");
  assert.equal(ok.statusCode, 200);
  assert.equal(parse(ok).open, true);
  assert.equal((await store.getState()).open, true);
});

test("admin limiter: only failures count per caller; a caller with the right password is never throttled", async () => {
  const { admin } = await adminSetup();
  for (let i = 0; i < 12; i += 1) assert.equal((await admin(i % 2 === 0, "correct horse battery staple", "198.51.100.5")).statusCode, 200);
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await admin(true, "wrong", "198.51.100.6")).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
  assert.equal((await admin(true, "correct horse battery staple", "198.51.100.6")).statusCode, 429, "the guessing caller stays blocked");
});

test("admin limiter: the global failure budget is modest but defaults to 300, and trips for everyone beyond it", async () => {
  assert.equal(loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "5" }).adminGlobalRateLimit, 300);
  const { admin } = await adminSetup({ config: { adminGlobalRateLimit: 10 } });
  for (let i = 0; i < 10; i += 1) assert.equal((await admin(true, "wrong", `192.0.2.${i + 1}`)).statusCode, 401);
  assert.equal((await admin(true, "wrong", "192.0.2.99")).statusCode, 429);
});

test("IPv6 callers are keyed on the /64 prefix; IPv4-mapped addresses count as IPv4", async () => {
  assert.equal(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), normalizeIp("2001:db8:1:2::1"));
  assert.equal(normalizeIp("2001:db8:1:2:0:0:0:1"), "2001:0db8:0001:0002::/64");
  assert.notEqual(normalizeIp("2001:db8:1:3::1"), normalizeIp("2001:db8:1:2::1"));
  assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("203.0.113.9"), "203.0.113.9");
  const { admin } = await adminSetup();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await admin(true, "wrong", `2001:db8:55:66:${i}:${i}:${i}:${i + 1}`)).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429], "rotating inside one /64 does not reset the limit");
});

test("admin secret: the cached hash expires, so a changed password takes effect after the TTL", async () => {
  const oldRecord = await hashPassword("old password for the admin");
  const newRecord = await hashPassword("new password for the admin");
  let current = oldRecord;
  let reads = 0;
  const { admin, clock } = await adminSetup({ getAdminSecret: async () => { reads += 1; return current; } });
  const attempt = (pw, n) => admin(true, pw, `198.51.100.${n}`);
  assert.equal((await attempt("old password for the admin", 1)).statusCode, 200);
  current = newRecord;
  assert.equal((await attempt("old password for the admin", 2)).statusCode, 200, "within the TTL the cached hash is still used");
  assert.equal(reads, 1);
  clock.ms += 61_000;
  assert.equal((await attempt("old password for the admin", 3)).statusCode, 401, "after the TTL the new hash is read");
  assert.equal((await attempt("new password for the admin", 4)).statusCode, 200);
  assert.equal(reads, 2);
});

test("closed: a paid pid still gets already_paid, a pending reservation with a signed tx may resume, new reservations are refused", async () => {
  for (const config of [undefined, PROLIFIC]) {
    const { claim, store, chain, clock, pids } = await setup({ config });
    const pid = config ? hex24() : pids[0];
    const to = addr();
    assert.equal((await claim(pid, to)).statusCode, 200);
    await store.setState(false, 5);
    const again = await claim(pid, to);
    assert.equal(again.statusCode, 200);
    assert.equal(parse(again).status, "already_paid");
    assert.equal(parse(await claim(pid, addr())).error, "faucet_closed", "another address learns nothing");
    // A brand-new id is refused without any write or slot.
    const fresh = config ? hex24() : pids[1];
    const budgetBefore = store.shared.budget;
    const sizeBefore = store.pids.size;
    assert.equal(parse(await claim(fresh, addr())).error, "faucet_closed");
    assert.equal(store.shared.budget, budgetBefore);
    assert.equal(store.pids.size, sizeBefore);
    if (!config) assert.equal(store.pids.get(sha256(pids[1])).status, "unclaimed");
    // In-flight: a payment that signed but failed to broadcast completes after the faucet closes.
    await store.setState(true, 6);
    const flying = config ? hex24() : pids[2];
    const flyingTo = addr();
    chain.state.failNextSend = true;
    assert.equal((await claim(flying, flyingTo)).statusCode, 500);
    await store.setState(false, 7);
    clock.ms += 120_000;
    assert.equal((await claim(flying, addr())).statusCode, 403, "other address refused");
    const resumed = await claim(flying, flyingTo);
    assert.equal(resumed.statusCode, 200, "the signed transaction is finished while closed");
    assert.equal(chain.mined.size, 2);
    if (config) assert.equal(store.shared.budget, 2, "no extra slot was taken");
  }
});

test("admin limiter: 300 wrong passwords from ONE IP add only 5 to the global budget; the right password from a new IP still works", async () => {
  const { admin, store } = await adminSetup();
  const codes = new Set();
  for (let i = 0; i < 300; i += 1) codes.add((await admin(true, `wrong ${i}`, "198.51.100.77")).statusCode);
  assert.deepEqual([...codes].sort(), [401, 429]);
  const global = [...store.counters].find(([key]) => key.startsWith("admf-global"));
  assert.equal(global[1].count, 5, "only the caller's 5 allowed failures reached the global counter");
  const ok = await admin(true, "correct horse battery staple", "203.0.113.201");
  assert.equal(ok.statusCode, 200);
  assert.equal(parse(ok).open, true);
  assert.equal([...store.counters].find(([key]) => key.startsWith("admf-global"))[1].count, 5, "the correct password was refunded");
});
