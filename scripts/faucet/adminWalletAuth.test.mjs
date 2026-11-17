// Admin wallet auth (x-admin-proof): generated keys and a fake chain, no network, no AWS.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Transaction, Wallet } from "ethers";

const require = createRequire(import.meta.url);
const { createFaucetHandler, loadConfig } = require("../../infrastructure/faucet/handler.js");
const { createAdminWalletAuth, ADMIN_GATE_STATEMENT, IS_ADMIN_SELECTOR } = require("../../infrastructure/faucet/adminWalletAuth.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { hashPassword } = require("../../infrastructure/faucet/adminAuth.js");

const PASSWORD = "correct horse battery staple";
const HOST = "test.example.org";
const ORIGIN = `https://${HOST}`;
const CHAIN_ID = 23293;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const NOW = 1_700_000_000_000;
const faucetWallet = Wallet.createRandom();
const CONFIG = {
  chainId: CHAIN_ID, amountWei: 10n ** 17n, rateLimit: 1000, globalRateLimit: 10000, rateWindowSeconds: 600, leaseSeconds: 60,
  confirmTimeoutMs: 1000, absentChecks: 1, absentDelayMs: 0, pidMode: "prolific", maxPayouts: 5, factoryAddress: FACTORY, allowedOrigins: [ORIGIN, "http://localhost:3000"],
};

const message = ({ address, host = HOST, uri = ORIGIN, chainId = CHAIN_ID, issued = NOW, minutes = 60, statement = ADMIN_GATE_STATEMENT, expires } = {}) => [
  `${host} wants you to sign in with your Ethereum account:`, address, "", statement, "", `URI: ${uri}`, "Version: 1", `Chain ID: ${chainId}`, "Nonce: abc123",
  `Issued At: ${new Date(issued).toISOString()}`, `Expiration Time: ${new Date(expires ?? issued + minutes * 60_000).toISOString()}`,
].join("\n");
const proofHeader = async (wallet, options = {}, signer = wallet) => {
  const text = message({ address: wallet.address, ...options });
  return Buffer.from(JSON.stringify({ address: wallet.address, message: text, signature: await signer.signMessage(text) })).toString("base64url");
};

const fakeChain = (admins) => {
  const calls = [];
  const chain = {
    calls, failRpc: false,
    getBalance: async () => 10n ** 20n, getNonce: async () => 0, getGasPrice: async () => 10n ** 11n,
    sendRaw: async (raw) => { Transaction.from(raw); }, getReceipt: async () => ({ status: 1 }), getTransaction: async () => null,
    call: async ({ to, data }) => {
      calls.push({ to, data });
      if (chain.failRpc) throw new Error("rpc down");
      assert.equal(to, FACTORY);
      assert.ok(data.startsWith(IS_ADMIN_SELECTOR) && data.length === 10 + 64);
      return `0x${admins.has(`0x${data.slice(-40)}`) ? "1".padStart(64, "0") : "0".repeat(64)}`;
    },
  };
  return chain;
};

const setup = async ({ config = {} } = {}) => {
  const admin = Wallet.createRandom();
  const admins = new Set([admin.address.toLowerCase()]);
  const chain = fakeChain(admins);
  const clock = { ms: NOW };
  const logs = [];
  const store = createMemoryStore();
  const record = await hashPassword(PASSWORD);
  const handler = createFaucetHandler({
    store, chain, config: { ...CONFIG, ...config }, getPrivateKey: async () => faucetWallet.privateKey, getRateSalt: async () => "salt",
    getAdminSecret: async () => record, now: () => clock.ms, log: (line) => logs.push(line),
  });
  await store.setState(true, 1_700_000_000);
  const send = (path, method, { body, headers, ip = "198.51.100.9" } = {}) => handler({
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body), headers, requestContext: { http: { method, sourceIp: ip } },
  });
  const withProof = (proof, ip) => ({ headers: { "x-admin-proof": proof }, ip });
  return { admin, admins, chain, clock, logs, store, send, withProof, events: () => logs.map((line) => JSON.parse(line)) };
};
const ROUTES = [
  ["/admin/status", "GET", undefined],
  ["/admin/state", "POST", { open: false }],
  ["/admin/max-payouts", "POST", { value: 7 }],
  ["/admin/sweeps", "GET", undefined],
  ["/admin/sweep-settings", "POST", { idleMinutes: 20 }],
  ["/admin/messages", "GET", undefined],
  ["/admin/messages", "POST", { all: true, body: "hello" }],
];

test("a proof from an on-chain admin passes on every /admin/* route, with no password", async () => {
  const t = await setup();
  const proof = await proofHeader(t.admin);
  for (const [path, method, body] of ROUTES) {
    const response = await t.send(path, method, { body, ...t.withProof(proof) });
    assert.equal(response.statusCode, 200, `${method} ${path} -> ${response.statusCode} ${response.body}`);
  }
  const events = t.events();
  assert.ok(events.some((e) => e.event === "admin_auth" && e.method === "wallet" && e.address === t.admin.address.toLowerCase()));
  assert.equal(events.find((e) => e.event === "admin_state_changed").admin, t.admin.address.toLowerCase(), "audit has the admin address");
  assert.equal(events.find((e) => e.event === "admin_max_payouts_changed").admin, t.admin.address.toLowerCase());
  assert.equal(t.logs.join("\n").includes(proof), false, "the proof is never logged");
});

const REFUSED = {
  "wrong origin": (w) => proofHeader(w, { host: "evil.example.org", uri: "https://evil.example.org" }),
  "http origin (not https)": (w) => proofHeader(w, { host: "localhost:3000", uri: "http://localhost:3000" }),
  "wrong uri": (w) => proofHeader(w, { uri: "https://other.example.org" }),
  "wrong chain": (w) => proofHeader(w, { chainId: 23295 }),
  expired: (w) => proofHeader(w, { issued: NOW - 62 * 60_000, minutes: 61 }),
  "expired expiration time": (w) => proofHeader(w, { issued: NOW - 30 * 60_000, minutes: 20 }),
  future: (w) => proofHeader(w, { issued: NOW + 5 * 60_000 }),
  "too-long expiry": (w) => proofHeader(w, { minutes: 62 }),
  "statement changed": (w) => proofHeader(w, { statement: "Please sign this unrelated text." }),
  "signature by another key": (w) => proofHeader(w, {}, Wallet.createRandom()),
};

test("proofs that are not exactly right are refused with 401 and never reach the chain", async () => {
  const t = await setup();
  for (const [name, make] of Object.entries(REFUSED)) {
    const response = await t.send("/admin/status", "GET", t.withProof(await make(t.admin), `203.0.113.${Object.keys(REFUSED).indexOf(name) + 1}`));
    assert.equal(response.statusCode, 401, name);
  }
  assert.equal(t.chain.calls.length, 0, "every check before the signature and the role is local");
});

test("malformed, oversized and non-address proofs are refused", async () => {
  const t = await setup();
  const big = Buffer.from(JSON.stringify({ address: t.admin.address, message: "x".repeat(5000), signature: "0x" })).toString("base64url");
  const bad = [big, "not base64 !!", Buffer.from("[]").toString("base64url"), Buffer.from(JSON.stringify({ address: "0x12", message: "m", signature: "s" })).toString("base64url"), ""];
  for (const [i, proof] of bad.entries()) assert.equal((await t.send("/admin/status", "GET", t.withProof(proof, `203.0.114.${i}`))).statusCode, 401, `case ${i}`);
});

test("a valid signature from a wallet that is not an admin on chain is refused", async () => {
  const t = await setup();
  const stranger = Wallet.createRandom();
  assert.equal((await t.send("/admin/status", "GET", t.withProof(await proofHeader(stranger)))).statusCode, 401);
  assert.equal(t.chain.calls.length, 1);
});

test("an RPC error is 503 (never fail open), is not counted as a failure, and recovers", async () => {
  const t = await setup();
  const proof = await proofHeader(t.admin);
  t.chain.failRpc = true;
  for (let i = 0; i < 8; i += 1) assert.equal((await t.send("/admin/status", "GET", t.withProof(proof))).statusCode, 503);
  t.chain.failRpc = false;
  assert.equal((await t.send("/admin/status", "GET", t.withProof(proof))).statusCode, 200, "an outage does not lock the admin out");
});

test("the role is cached: true for 60 s, false for 10 s; a removed admin is refused after the cache expires", async () => {
  const t = await setup();
  const proof = await proofHeader(t.admin);
  const ok = () => t.send("/admin/status", "GET", t.withProof(proof));
  assert.equal((await ok()).statusCode, 200);
  assert.equal((await ok()).statusCode, 200);
  assert.equal(t.chain.calls.length, 1, "cache hit avoids a second eth_call");
  t.admins.clear(); // removed on chain
  t.clock.ms += 59_000;
  assert.equal((await ok()).statusCode, 200, "still cached");
  t.clock.ms += 2_000;
  assert.equal((await ok()).statusCode, 401, "refused once the 60 s cache has expired");
  assert.equal(t.chain.calls.length, 2);
  t.admins.add(t.admin.address.toLowerCase()); // re-added
  t.clock.ms += 5_000;
  assert.equal((await ok()).statusCode, 401, "a negative answer is cached for 10 s");
  assert.equal(t.chain.calls.length, 2);
  t.clock.ms += 6_000;
  assert.equal((await ok()).statusCode, 200);
  assert.equal(t.chain.calls.length, 3);
});

test("the password still works as a fallback and is audited as such", async () => {
  const t = await setup();
  assert.equal((await t.send("/admin/status", "GET", { headers: { "x-admin-password": PASSWORD } })).statusCode, 200);
  assert.equal((await t.send("/admin/state", "POST", { body: { open: true, password: PASSWORD } })).statusCode, 200);
  assert.equal((await t.send("/admin/status", "GET", { headers: { "x-admin-password": "wrong" } })).statusCode, 401);
  const events = t.events();
  assert.ok(events.some((e) => e.event === "admin_auth" && e.method === "password" && e.address === undefined));
  assert.equal(events.find((e) => e.event === "admin_state_changed").admin, undefined);
  assert.equal(t.logs.join("\n").includes(PASSWORD), false);
});

test("a bad proof is not rescued by a correct password in the same request", async () => {
  const t = await setup();
  const stranger = await proofHeader(Wallet.createRandom());
  assert.equal((await t.send("/admin/status", "GET", { headers: { "x-admin-proof": stranger, "x-admin-password": PASSWORD } })).statusCode, 401);
});

test("proof failures are rate limited with the existing failure counters, and a good proof is not counted", async () => {
  const t = await setup();
  const stranger = await proofHeader(Wallet.createRandom());
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await t.send("/admin/status", "GET", t.withProof(stranger, "198.51.100.77"))).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
  assert.equal((await t.send("/admin/status", "GET", { headers: { "x-admin-password": PASSWORD }, ip: "198.51.100.77" })).statusCode, 429, "shared with password failures");
  const good = await proofHeader(t.admin);
  for (let i = 0; i < 12; i += 1) assert.equal((await t.send("/admin/status", "GET", t.withProof(good, "198.51.100.88"))).statusCode, 200);
});

test("without FACTORY_ADDRESS wallet auth is disabled: a proof is ignored and only the password works", async () => {
  const t = await setup({ config: { factoryAddress: "" } });
  const proof = await proofHeader(t.admin);
  assert.equal((await t.send("/admin/status", "GET", t.withProof(proof))).statusCode, 401);
  assert.equal((await t.send("/admin/status", "GET", { headers: { "x-admin-proof": proof, "x-admin-password": PASSWORD } })).statusCode, 200);
  assert.equal(t.chain.calls.length, 0);
});

test("module: reasons, statement parity with the client and config parsing", async () => {
  const chain = fakeChain(new Set());
  const auth = createAdminWalletAuth({ chain, factoryAddress: FACTORY, chainId: CHAIN_ID, allowedOrigins: [ORIGIN], now: () => NOW });
  const w = Wallet.createRandom();
  assert.equal((await auth.verify(await proofHeader(w, { chainId: 1 }))).reason, "wrong-chain");
  assert.equal((await auth.verify(await proofHeader(w, { host: "x.org", uri: "https://x.org" }))).reason, "wrong-origin");
  assert.equal((await auth.verify(await proofHeader(w, { uri: "https://x.org" }))).reason, "wrong-uri");
  assert.equal((await auth.verify(await proofHeader(w, { minutes: 90 }))).reason, "bad-lifetime");
  assert.equal((await auth.verify(await proofHeader(w))).reason, "not-admin");
  assert.deepEqual(await createAdminWalletAuth({ chain, factoryAddress: "", chainId: CHAIN_ID, allowedOrigins: [ORIGIN] }).verify("x"), { ok: false, reason: "disabled" });
  const gate = fs.readFileSync(new URL("../../src/pages/ManageBudget/adminGate.js", import.meta.url), "utf8");
  assert.ok(gate.includes(`ADMIN_GATE_STATEMENT =\n  "${ADMIN_GATE_STATEMENT}"`) || gate.includes(ADMIN_GATE_STATEMENT), "server and client statement are identical");
  const config = loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "1", FACTORY_ADDRESS: "0xf6d6e74e113CE7107b8a7edB7427927e51e3A146", ALLOWED_ORIGINS: "https://a.org, http://localhost:3000" });
  assert.equal(config.factoryAddress, "0xf6d6e74e113CE7107b8a7edB7427927e51e3A146");
  assert.deepEqual(config.allowedOrigins, ["https://a.org", "http://localhost:3000"]);
  assert.equal(loadConfig({ CHAIN_ID: "23295", FAUCET_AMOUNT_WEI: "1", FACTORY_ADDRESS: "nonsense" }).factoryAddress, "");
});
