import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Transaction, Wallet } from "ethers";

const require = createRequire(import.meta.url);
const { createFaucetHandler } = require("../../infrastructure/faucet/handler.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { hashPassword } = require("../../infrastructure/faucet/adminAuth.js");

const AMOUNT = 10n ** 17n;
const PASSWORD = "correct horse battery staple";
const faucetWallet = Wallet.createRandom();
const CONFIG = { chainId: 23293, amountWei: AMOUNT, rateLimit: 1000, globalRateLimit: 10000, rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 1000, absentChecks: 1, absentDelayMs: 0, pidMode: "prolific", maxPayouts: 2 };

const fakeChain = () => {
  const mined = new Map();
  let nonce = 0;
  return {
    sent: [],
    getBalance: async () => 10n ** 20n,
    getNonce: async () => nonce,
    getGasPrice: async () => 10n ** 11n,
    sendRaw: async (raw) => { const tx = Transaction.from(raw); mined.set(tx.hash, tx); nonce += 1; },
    getReceipt: async (hash) => (mined.has(hash) ? { status: 1 } : null),
    getTransaction: async (hash) => mined.get(hash) || null,
  };
};

const setup = async ({ config = {}, adminSecret = true } = {}) => {
  const store = createMemoryStore();
  const logs = [];
  const record = await hashPassword(PASSWORD);
  const handler = createFaucetHandler({
    store, chain: fakeChain(), config: { ...CONFIG, ...config }, getPrivateKey: async () => faucetWallet.privateKey,
    getRateSalt: async () => "salt", getAdminSecret: async () => (adminSecret ? record : null), now: () => 1_700_000_000_000, log: (line) => logs.push(line),
  });
  await store.setState(true, 1_700_000_000);
  const hex24 = () => Wallet.createRandom().privateKey.slice(2, 26);
  const send = (path, method, { body, headers, ip = "198.51.100.9" } = {}) => handler({
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body), headers, requestContext: { http: { method, sourceIp: ip } },
  });
  const status = (password = PASSWORD, ip) => send("/admin/status", "GET", { headers: password === null ? {} : { "x-admin-password": password }, ip });
  const setMax = (value, password = PASSWORD, ip) => send("/admin/max-payouts", "POST", { body: { value, password }, ip });
  const raw = send;
  const claim = () => send("/claim", "POST", { body: { pid: hex24(), address: Wallet.createRandom().address }, ip: "203.0.113.5" });
  return { store, logs, status, setMax, claim, send: raw };
};
const parse = (response) => JSON.parse(response.body);

test("GET /admin/status needs the admin password (header) and returns the payout figures", async () => {
  const { status, claim } = await setup();
  assert.equal((await status("wrong")).statusCode, 401);
  assert.equal((await status(null)).statusCode, 401, "no header");
  await claim();
  const ok = await status();
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(parse(ok), { payoutsUsed: 1, maxPayouts: 2, faucetAddress: faucetWallet.address, payoutAmount: AMOUNT.toString(), open: true });
});

test("admin endpoints: unconfigured admin secret, wrong method and a password in the body of GET never work", async () => {
  const none = await setup({ adminSecret: false });
  assert.equal((await none.status()).statusCode, 401);
  assert.equal((await none.setMax(5)).statusCode, 401);
  const t = await setup();
  assert.equal((await t.send("/admin/status", "POST", { body: { password: PASSWORD } })).statusCode, 405);
  assert.equal((await t.send("/admin/max-payouts", "GET", { headers: { "x-admin-password": PASSWORD } })).statusCode, 405);
  assert.equal((await t.send("/admin/status", "GET", { body: { password: PASSWORD } })).statusCode, 401, "a body password does not authorise GET");
});

test("POST /admin/max-payouts: auth required, wrong password changes nothing", async () => {
  const { setMax, store } = await setup();
  const denied = await setMax(50, "nope");
  assert.equal(denied.statusCode, 401);
  assert.equal(await store.getMaxPayouts(), null);
});

test("POST /admin/max-payouts validates: integer, >= payoutsUsed, <= 1000", async () => {
  const { setMax, claim, store } = await setup();
  await claim(); await claim();
  for (const bad of [1.5, "10", null, undefined, 0, -3, 1001, 10 ** 6, NaN]) {
    assert.equal((await setMax(bad)).statusCode, 400, `value ${String(bad)}`);
  }
  const below = await setMax(1);
  assert.equal(below.statusCode, 400);
  assert.deepEqual(parse(below), { error: "below_used", payoutsUsed: 2 });
  assert.equal(await store.getMaxPayouts(), null);
  assert.equal((await setMax(2)).statusCode, 200, "equal to payoutsUsed is allowed");
  assert.equal((await setMax(1000)).statusCode, 200, "1000 is the upper bound");
});

test("the new limit persists, shows in status, is audited, and the claim path respects it", async () => {
  const { setMax, status, claim, store, logs } = await setup();
  assert.equal((await claim()).statusCode, 200);
  assert.equal((await claim()).statusCode, 200);
  const full = await claim();
  assert.equal(full.statusCode, 403);
  assert.equal(parse(full).error, "budget_exhausted");

  const raised = await setMax(4);
  assert.deepEqual(parse(raised), { payoutsUsed: 2, maxPayouts: 4 });
  assert.equal(await store.getMaxPayouts(), 4, "persisted in the store");
  assert.equal(parse(await status()).maxPayouts, 4);
  assert.equal((await claim()).statusCode, 200);
  assert.equal((await claim()).statusCode, 200);
  assert.equal(parse(await claim()).error, "budget_exhausted", "the stored limit (4) is enforced, not the deploy-time 2");

  const audit = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "admin_max_payouts_changed");
  assert.deepEqual(audit, { event: "admin_max_payouts_changed", from: 2, to: 4, payoutsUsed: 2 });
  assert.equal(logs.join("\n").includes(PASSWORD), false, "the password is never logged");
});

test("without a stored value the deploy-time limit is used; a failing read never lifts the cap", async () => {
  const { claim, status, store } = await setup();
  assert.equal(parse(await status()).maxPayouts, 2);
  store.getMaxPayouts = async () => { throw new Error("dynamodb unavailable"); };
  await claim(); await claim();
  assert.equal((await claim()).statusCode, 403);
});

test("allowlist mode: status reports no cap and the limit cannot be set", async () => {
  const { status, setMax } = await setup({ config: { pidMode: "allowlist", maxPayouts: null } });
  const body = parse(await status());
  assert.equal(body.maxPayouts, null);
  assert.equal(body.payoutsUsed, 0);
  const res = await setMax(10);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(parse(res), { error: "not_applicable" });
});

test("admin endpoints share the failed-attempt rate limit", async () => {
  const { status, setMax } = await setup();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await status("wrong", "198.51.100.77")).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
  assert.equal((await setMax(5, PASSWORD, "198.51.100.77")).statusCode, 429);
});
