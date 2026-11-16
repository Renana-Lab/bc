// Auto-return ("sweep") on the faucet server: arm validation, replacement, heartbeat, the scheduled job and the admin endpoints.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Transaction, Wallet } from "ethers";

const require = createRequire(import.meta.url);
const { createFaucetHandler, sha256 } = require("../../infrastructure/faucet/handler.js");
const { runSweepJob, sweepMessage } = require("../../infrastructure/faucet/sweep.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { hashPassword } = require("../../infrastructure/faucet/adminAuth.js");

const PASSWORD = "correct horse battery staple";
const CHAIN_ID = 23293;
const GAS_PRICE = 100n * 10n ** 9n;
const GAS_LIMIT = 60000n;
const faucetWallet = Wallet.createRandom();
const CONFIG = { chainId: CHAIN_ID, amountWei: 10n ** 17n, rateLimit: 1000, globalRateLimit: 10000, rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 1000, absentChecks: 1, absentDelayMs: 0, sweepAddress: faucetWallet.address, sweepIdleMinutes: 30 };

const fakeChain = () => {
  const accounts = new Map(); // lowercase -> { balance, nonce }
  const mined = new Map();
  const chain = {
    accounts, mined, sent: [], failWith: null,
    set: (address, balance, nonce = 0) => accounts.set(address.toLowerCase(), { balance, nonce }),
    getBalance: async (address) => accounts.get(address.toLowerCase())?.balance ?? 0n,
    getNonce: async (address) => accounts.get(address.toLowerCase())?.nonce ?? 0,
    sendRaw: async (raw) => {
      chain.sent.push(raw);
      if (chain.failWith) throw new Error(chain.failWith);
      const tx = Transaction.from(raw);
      const account = accounts.get(tx.from.toLowerCase());
      if (account.nonce !== tx.nonce) throw new Error("nonce too low");
      account.nonce += 1;
      account.balance -= tx.value + tx.gasPrice * tx.gasLimit;
      mined.set(tx.hash, tx);
    },
    getReceipt: async (hash) => (mined.has(hash) ? { status: 1 } : null),
    getTransaction: async (hash) => mined.get(hash) || null,
  };
  return chain;
};

const setup = async ({ config = {} } = {}) => {
  const store = createMemoryStore();
  const chain = fakeChain();
  const clock = { ms: 1_700_000_000_000 };
  const record = await hashPassword(PASSWORD);
  const full = { ...CONFIG, ...config };
  const handler = createFaucetHandler({
    store, chain, config: full, getPrivateKey: async () => faucetWallet.privateKey, getRateSalt: async () => "salt",
    getAdminSecret: async () => record, now: () => clock.ms, log: () => {},
  });
  const send = (path, method, { body, headers, ip = "198.51.100.9" } = {}) => handler({
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body), headers, requestContext: { http: { method, sourceIp: ip } },
  });
  // A participant that was paid by the faucet (record keyed by the pid hash, bound to its address).
  const participant = async (balance = 10n ** 18n) => {
    const wallet = Wallet.createRandom();
    const pidHash = sha256(`pid-${wallet.address}`);
    store.pids.set(pidHash, { status: "paid", address: wallet.address.toLowerCase(), txHash: "0x1" });
    chain.set(wallet.address, balance, 0);
    const sign = (overrides = {}) => wallet.signTransaction({
      type: 0, chainId: CHAIN_ID, to: faucetWallet.address, value: (balance - GAS_PRICE * GAS_LIMIT * 12n / 10n), nonce: 0, gasPrice: GAS_PRICE, gasLimit: GAS_LIMIT, ...overrides,
    });
    const arm = async (rawTx, extra = {}) => send("/sweep/arm", "POST", { body: { pidHash, address: wallet.address, rawTx: rawTx ?? (await sign()), ...extra } });
    const signedAs = async (action, signer = wallet, ts = clock.ms) => ({ ts, sig: await signer.signMessage(sweepMessage(action, wallet.address, pidHash, ts)) });
    const heartbeat = async (extra = {}, signer = wallet) => send("/sweep/heartbeat", "POST", { body: { pidHash, address: wallet.address, ...(await signedAs("heartbeat", signer)), ...extra } });
    const cancel = async (extra = {}, signer = wallet, ts = clock.ms + 1000) => send("/sweep/arm", "POST", { body: { pidHash, address: wallet.address, cancel: true, signedAt: ts, sig: (await signedAs("cancel", signer, ts)).sig, ...extra } });
    return { wallet, pidHash, sign, arm, heartbeat, cancel, signedAs, address: wallet.address };
  };
  const job = () => runSweepJob({ store, chain, config: full, now: () => clock.ms });
  const admin = (path, method = "GET", body, password = PASSWORD) => send(path, method, {
    body: method === "POST" ? { ...body, ...(password === null ? {} : { password }) } : undefined,
    headers: method === "GET" && password !== null ? { "x-admin-password": password } : {},
  });
  return { store, chain, clock, send, participant, job, admin };
};
const parse = (response) => JSON.parse(response.body);
const MINUTE = 60_000;

test("GET /sweep/config exposes only the sweep address, chain, pid mode and server time", async () => {
  const t = await setup();
  const { send } = t;
  const body = parse(await send("/sweep/config", "GET"));
  assert.deepEqual(body, { sweepAddress: faucetWallet.address, chainId: CHAIN_ID, pidMode: "allowlist", serverTime: t.clock.ms });
  assert.equal((await send("/sweep/config", "POST")).statusCode, 405);
});

test("arm stores a valid pre-signed transfer", async () => {
  const t = await setup();
  const p = await t.participant();
  const response = await p.arm();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(parse(response).status, "armed");
  const listed = parse(await t.admin("/admin/sweeps")).sweeps;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].address, p.address.toLowerCase());
  assert.equal(listed[0].status, "armed");
  assert.equal(listed[0].pidHash, p.pidHash);
  assert.equal(BigInt(listed[0].armedValue) > 0n, true);
});

test("arm rejects a wrong recipient, a data payload, the wrong chain, a value above the balance and a foreign signer", async () => {
  const t = await setup();
  const p = await t.participant();
  const reason = async (rawTx) => { const r = await p.arm(rawTx); return [r.statusCode, parse(r).reason ?? parse(r).error]; };
  assert.deepEqual(await reason(await p.sign({ to: Wallet.createRandom().address })), [422, "recipient"]);
  assert.deepEqual(await reason(await p.sign({ data: "0xdeadbeef" })), [422, "data"]);
  assert.deepEqual(await reason(await p.sign({ chainId: 1 })), [422, "chain"]);
  assert.deepEqual(await reason(await p.sign({ value: 2n * 10n ** 18n })), [422, "balance"]);
  assert.deepEqual(await reason(await p.sign({ gasLimit: 5_000_000n })), [422, "gas"]);
  assert.deepEqual(await reason(await p.sign({ value: 0n })), [422, "value"]);
  assert.deepEqual(await reason("0x1234"), [422, "decode"]);
  const stranger = Wallet.createRandom();
  const foreign = await stranger.signTransaction({ type: 0, chainId: CHAIN_ID, to: faucetWallet.address, value: 1n, nonce: 0, gasPrice: GAS_PRICE, gasLimit: GAS_LIMIT });
  assert.deepEqual(await reason(foreign), [422, "signer"]);
  assert.deepEqual(await reason(await p.sign({ nonce: 3 })), [409, "nonce_mismatch"]);
  assert.equal(parse(await t.admin("/admin/sweeps")).sweeps.length, 0, "nothing was stored");
});

test("arm rejects missing or malformed fields and ids the faucet never paid", async () => {
  const t = await setup();
  const p = await t.participant();
  const post = (body) => t.send("/sweep/arm", "POST", { body });
  assert.equal((await post({})).statusCode, 400);
  assert.equal((await post({ pidHash: p.pidHash, address: p.address })).statusCode, 400, "no rawTx");
  assert.equal((await post({ pidHash: "nope", address: p.address, rawTx: await p.sign() })).statusCode, 400);
  assert.equal((await post({ pidHash: p.pidHash, address: "0x12", rawTx: await p.sign() })).statusCode, 400);
  assert.equal((await post({ pidHash: sha256("unknown"), address: p.address, rawTx: await p.sign() })).statusCode, 403);
  assert.equal((await post({ pidHash: p.pidHash, address: Wallet.createRandom().address, rawTx: await p.sign() })).statusCode, 403, "pid belongs to another address");
  assert.equal((await t.send("/sweep/arm", "GET")).statusCode, 405);
  assert.equal((await t.send("/sweep/arm", "POST", { body: { pad: "x".repeat(3000) } })).statusCode, 413);
});

test("a newer arm replaces an older one; an older signature never overwrites a newer one", async () => {
  const t = await setup();
  const p = await t.participant();
  assert.equal((await p.arm(await p.sign({ value: 10n ** 17n }), { signedAt: t.clock.ms })).statusCode, 200);
  assert.equal((await p.arm(await p.sign({ value: 2n * 10n ** 17n }), { signedAt: t.clock.ms + 1000 })).statusCode, 200);
  assert.equal(parse(await t.admin("/admin/sweeps")).sweeps[0].armedValue, (2n * 10n ** 17n).toString());
  const older = await p.arm(await p.sign({ value: 3n * 10n ** 17n }), { signedAt: t.clock.ms - 5000 });
  assert.equal(older.statusCode, 409);
  assert.equal(parse(await t.admin("/admin/sweeps")).sweeps[0].armedValue, (2n * 10n ** 17n).toString());
});

test("cancel disarms, and the job then does nothing", async () => {
  const t = await setup();
  const p = await t.participant();
  await p.arm();
  const cancelled = await p.cancel();
  assert.equal(parse(cancelled).status, "none");
  t.clock.ms += 120 * MINUTE;
  assert.deepEqual(await t.job(), { sent: 0, stale: 0, confirmed: 0, retry: 0, skipped: 0 });
  assert.equal(t.chain.sent.length, 0);
  assert.equal(parse(await t.admin("/admin/sweeps")).sweeps[0].status, "none");
});

test("the job broadcasts only after the idle time and only once; heartbeats keep a participant active", async () => {
  const t = await setup();
  const p = await t.participant();
  const other = await t.participant();
  await p.arm();
  await other.arm();
  t.clock.ms += 29 * MINUTE;
  await t.job();
  assert.equal(t.chain.sent.length, 0, "not idle long enough");
  // `other` is still around: its heartbeat moves lastSeen forward.
  const beat = await other.heartbeat();
  assert.equal(parse(beat).status, "armed");
  t.clock.ms += 2 * MINUTE;
  assert.equal((await t.job()).sent, 1);
  assert.equal(t.chain.sent.length, 1);
  assert.equal(Transaction.from(t.chain.sent[0]).from.toLowerCase(), p.address.toLowerCase());
  assert.equal(Transaction.from(t.chain.sent[0]).to, faucetWallet.address);
  await t.job();
  assert.equal(t.chain.sent.length, 1, "broadcast once");
  const sweeps = parse(await t.admin("/admin/sweeps")).sweeps;
  const sent = sweeps.find((s) => s.address === p.address.toLowerCase());
  assert.equal(sent.status, "sent");
  assert.match(sent.txHash, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(sent.returnedWei) > 0n, "confirmed amount is recorded");
  assert.equal(sweeps.find((s) => s.address === other.address.toLowerCase()).status, "armed");
});

test("cancel and heartbeat need a signature of the participant wallet: a pid hash alone is not enough", async () => {
  const t = await setup();
  const p = await t.participant();
  await p.arm();
  const stranger = Wallet.createRandom();
  // Unsigned, signed by someone else, signed for another action, expired and wrong-pid requests are all refused.
  assert.equal((await t.send("/sweep/arm", "POST", { body: { pidHash: p.pidHash, address: p.address, cancel: true, signedAt: t.clock.ms } })).statusCode, 403);
  assert.equal((await p.cancel({}, stranger)).statusCode, 403);
  assert.equal((await p.cancel({ sig: (await p.signedAs("heartbeat", p.wallet, t.clock.ms + 1000)).sig })).statusCode, 403, "a heartbeat signature cannot cancel");
  assert.equal((await p.cancel({}, p.wallet, t.clock.ms - 10 * MINUTE)).statusCode, 403, "outside the 5 minute window");
  assert.equal((await t.send("/sweep/heartbeat", "POST", { body: { pidHash: p.pidHash, address: p.address } })).statusCode, 403);
  assert.equal((await p.heartbeat({}, stranger)).statusCode, 403);
  assert.equal((await p.heartbeat({ ts: t.clock.ms - 10 * MINUTE })).statusCode, 403);
  assert.equal(parse(await t.admin("/admin/sweeps")).sweeps[0].status, "armed", "nothing changed");
  // The owner's own signed requests work; a wrong pid hash gets "none", a malformed request 400.
  assert.equal(parse(await p.heartbeat()).status, "armed");
  assert.equal((await p.heartbeat({ pidHash: sha256("other") })).statusCode, 403, "signature is bound to the pid hash");
  assert.equal((await t.send("/sweep/heartbeat", "POST", { body: { address: p.address } })).statusCode, 400);
  assert.equal(parse(await p.cancel()).status, "none");
});

test("a heartbeat between the scan and the claim cancels the broadcast (claim needs lastSeen < idleBefore)", async () => {
  const t = await setup();
  const p = await t.participant();
  await p.arm();
  t.clock.ms += 31 * MINUTE;
  const record = await t.store.getSweep(p.address);
  const nowSec = Math.floor(t.clock.ms / 1000);
  const idleBefore = nowSec - 30 * 60;
  assert.equal(record.lastSeen < idleBefore, true, "idle at scan time");
  await p.heartbeat(); // the participant is back right now
  assert.equal(await t.store.claimSweep(p.address, record.signedAt, nowSec, nowSec - 600, idleBefore), false);
  assert.equal((await t.store.getSweep(p.address)).status, "armed", "not claimed");
  // A scan that raced the same way inside the job: it re-reads nothing, the claim alone decides.
  const original = t.store.listSweeps;
  t.store.listSweeps = async () => { const list = await original(); await p.heartbeat(); return list; };
  assert.equal((await t.job()).sent, 0);
  assert.equal(t.chain.sent.length, 0);
  t.store.listSweeps = original;
});

test("stale when the nonce was used or the balance changed after arming (the participant was active)", async () => {
  const t = await setup();
  const usedNonce = await t.participant();
  const spent = await t.participant();
  await usedNonce.arm();
  await spent.arm();
  t.chain.accounts.get(usedNonce.address.toLowerCase()).nonce = 1; // the participant sent something else
  t.chain.accounts.get(spent.address.toLowerCase()).balance = 10n ** 16n; // the balance dropped below the signed value
  t.clock.ms += 31 * MINUTE;
  const result = await t.job();
  assert.equal(result.stale, 2);
  assert.equal(t.chain.sent.length, 0, "nothing broadcast");
  assert.deepEqual(parse(await t.admin("/admin/sweeps")).sweeps.map((s) => s.status), ["stale", "stale"]);
  // The next arm replaces a stale record.
  t.chain.set(usedNonce.address, 10n ** 18n, 1);
  assert.equal((await usedNonce.arm(await usedNonce.sign({ nonce: 1 }), { signedAt: t.clock.ms })).statusCode, 200);
  assert.equal(parse(await t.admin("/admin/sweeps")).sweeps.find((s) => s.address === usedNonce.address.toLowerCase()).status, "armed");
});

test("a broadcast that fails because the nonce was taken meanwhile is stale; a transient failure is retried then goes stale", async () => {
  const t = await setup();
  const p = await t.participant();
  await p.arm();
  t.clock.ms += 31 * MINUTE;
  t.chain.failWith = "nonce too low";
  assert.equal((await t.job()).stale, 1);
  const q = await t.participant();
  await q.arm();
  t.clock.ms += 31 * MINUTE;
  t.chain.failWith = "network down";
  assert.equal((await t.job()).retry, 1);
  assert.equal((await t.job()).retry, 1);
  assert.equal((await t.job()).stale, 1, "third failed attempt gives up");
});

test("admin endpoints need the admin password; idle minutes are editable (15..1440) and drive the job", async () => {
  const t = await setup();
  const p = await t.participant();
  await p.arm();
  assert.equal((await t.admin("/admin/sweeps", "GET", undefined, "wrong")).statusCode, 401);
  assert.equal((await t.admin("/admin/sweeps", "GET", undefined, null)).statusCode, 401);
  assert.equal((await t.admin("/admin/sweep-settings", "POST", { idleMinutes: 20 }, "wrong")).statusCode, 401);
  assert.equal((await t.admin("/admin/sweep-settings", "POST", { idleMinutes: 20 }, null)).statusCode, 401);
  for (const bad of [14, 5, 1441, 20.5, "20", null]) assert.equal((await t.admin("/admin/sweep-settings", "POST", { idleMinutes: bad })).statusCode, 400, String(bad));
  assert.equal((await t.admin("/admin/sweeps", "POST")).statusCode, 405);
  assert.equal(parse(await t.admin("/admin/sweeps")).idleMinutes, 30);
  assert.equal((await t.admin("/admin/sweep-settings", "POST", { idleMinutes: 60 })).statusCode, 200);
  assert.equal(parse(await t.admin("/admin/sweeps")).idleMinutes, 60);
  t.clock.ms += 45 * MINUTE;
  await t.job();
  assert.equal(t.chain.sent.length, 0, "45 minutes is not idle under a 60 minute setting");
  t.clock.ms += 20 * MINUTE;
  await t.job();
  assert.equal(t.chain.sent.length, 1);
});

test("/sweep/* is rate limited per caller like /claim", async () => {
  const t = await setup({ config: { sweepRateLimit: 3 } });
  const p = await t.participant();
  const codes = [];
  const beat = async (ip) => t.send("/sweep/heartbeat", "POST", { body: { pidHash: p.pidHash, address: p.address, ...(await p.signedAs("heartbeat")) }, ip });
  for (let i = 0; i < 5; i += 1) codes.push((await beat("192.0.2.77")).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal((await beat("192.0.2.78")).statusCode, 200, "another caller is unaffected");
});
