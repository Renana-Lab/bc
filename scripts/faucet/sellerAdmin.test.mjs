// Admin routes for the seller bots (/admin/seller-bots*): auth, validation, version conflicts, write-only payloads, kill switch, fund route.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Transaction, Wallet } from "ethers";
import { ADDRESS, NOW, PAYLOAD, createFakeChain, makeBot, makeConfig, makeItem } from "./sellerFakes.mjs";

const require = createRequire(import.meta.url);
const { createFaucetHandler, loadConfig } = require("../../infrastructure/faucet/handler.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { createMemorySellerStore } = require("../../infrastructure/faucet/sellerStore.js");
const { hashPassword } = require("../../infrastructure/faucet/adminAuth.js");
const { ADMIN_GATE_STATEMENT } = require("../../infrastructure/faucet/adminWalletAuth.js");

const PASSWORD = "correct horse battery staple";
const HOST = "test.example.org";
const ORIGIN = `https://${HOST}`;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const faucetWallet = Wallet.createRandom();
const BASE = { chainId: 23293, amountWei: 10n ** 17n, rateLimit: 1000, globalRateLimit: 10000, rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 1000, absentChecks: 1, absentDelayMs: 0, pidMode: "allowlist", adminRateLimit: 50, adminGlobalRateLimit: 500 };

const setup = async ({ config = {}, deployed = true, admins = new Set() } = {}) => {
  const logs = [];
  const chain = createFakeChain();
  chain.call = async ({ data }) => `0x${admins.has(`0x${data.slice(-40)}`) ? "1".padStart(64, "0") : "0".repeat(64)}`;
  chain.getBalance = async (address) => (address.toLowerCase() === faucetWallet.address.toLowerCase() ? 10n ** 21n : 3n * 10n ** 18n);
  chain.getGasPrice = async () => 10n ** 11n;
  chain.sendRaw = async () => {};
  chain.getReceipt = async () => ({ status: 1 });
  const sellerStore = createMemorySellerStore();
  const store = createMemoryStore();
  const record = await hashPassword(PASSWORD);
  const handler = createFaucetHandler({
    store, sellerStore, chain, getPrivateKey: async () => faucetWallet.privateKey, getRateSalt: async () => "salt", getAdminSecret: async () => record, now: () => NOW, log: (line) => logs.push(line),
    config: { ...BASE, factoryAddress: FACTORY, allowedOrigins: [ORIGIN], sellerBotAddresses: deployed ? [ADDRESS["bot-1"], ADDRESS["bot-2"]] : [], sellerFundingMaxWei: 0n, sellerFundingDailyMaxWei: null, ...config },
  });
  const send = (path, method, { body, password = PASSWORD, headers = {}, ip = "198.51.100.9" } = {}) => handler({
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(password ? { "x-admin-password": password } : {}), ...headers }, requestContext: { http: { method, sourceIp: ip } },
  });
  return { send, sellerStore, logs, chain };
};
const body = (response) => JSON.parse(response.body);
const draft = (over = {}) => ({ version: 0, enabled: false, presenceMode: "sweep", minActiveParticipants: 1, activeWindowMinutes: 5, idleGraceMinutes: 5, bots: [{ id: "bot-1", running: true, maxConcurrentOpen: 1, spacingSeconds: 60, minNativeBalance: 0.1, items: [{ description: "desc", payload: PAYLOAD, minimumBid: 5, durationMinutes: 2, quantity: 3 }] }], ...over });

test("404 when the seller part is not deployed (no addresses), for every route", async () => {
  const t = await setup({ deployed: false });
  for (const [path, method] of [["/admin/seller-bots", "GET"], ["/admin/seller-bots", "POST"], ["/admin/seller-bots/stop-all", "POST"], ["/admin/seller-bots/fund", "POST"]]) {
    assert.equal((await t.send(path, method, { body: method === "POST" ? draft() : undefined })).statusCode, 404, path);
  }
});

test("auth is required on every route (password), wrong or missing password is 401", async () => {
  const t = await setup();
  for (const [path, method] of [["/admin/seller-bots", "GET"], ["/admin/seller-bots", "POST"], ["/admin/seller-bots/stop-all", "POST"]]) {
    assert.equal((await t.send(path, method, { body: method === "POST" ? draft() : undefined, password: "nope" })).statusCode, 401, `${path} wrong`);
    assert.equal((await t.send(path, method, { body: method === "POST" ? draft() : undefined, password: "" })).statusCode, 401, `${path} none`);
  }
  assert.equal((await t.send("/admin/seller-bots", "GET")).statusCode, 200);
  assert.equal(await t.sellerStore.getConfig(), null, "nothing was written by unauthenticated calls");
});

test("a wallet proof from an on-chain admin is accepted, a stranger's is refused", async () => {
  const admin = Wallet.createRandom();
  const t = await setup({ admins: new Set([admin.address.toLowerCase()]) });
  const proofFor = async (wallet) => {
    const text = [`${HOST} wants you to sign in with your Ethereum account:`, wallet.address, "", ADMIN_GATE_STATEMENT, "", `URI: ${ORIGIN}`, "Version: 1", "Chain ID: 23293", "Nonce: abc12345",
      `Issued At: ${new Date(NOW).toISOString()}`, `Expiration Time: ${new Date(NOW + 3600_000).toISOString()}`].join("\n");
    return Buffer.from(JSON.stringify({ address: wallet.address, message: text, signature: await wallet.signMessage(text) })).toString("base64url");
  };
  assert.equal((await t.send("/admin/seller-bots", "GET", { password: "", headers: { "x-admin-proof": await proofFor(admin) } })).statusCode, 200);
  assert.equal((await t.send("/admin/seller-bots", "GET", { password: "", headers: { "x-admin-proof": await proofFor(Wallet.createRandom()) } })).statusCode, 401);
});

test("GET: default config with the known bots, payloads never returned (byte lengths only), addresses and balances", async () => {
  const t = await setup();
  const initial = body(await t.send("/admin/seller-bots", "GET"));
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.config.bots.map((bot) => bot.id), ["bot-1", "bot-2"]);
  assert.equal(initial.config.bots[0].address, ADDRESS["bot-1"]);
  assert.equal(initial.config.bots[0].balanceWei, (3n * 10n ** 18n).toString());
  const saved = await t.send("/admin/seller-bots", "POST", { body: draft() });
  assert.equal(saved.statusCode, 200, saved.body);
  const got = await t.send("/admin/seller-bots", "GET");
  assert.equal(got.body.includes(PAYLOAD), false, "write-only payload");
  const item = body(got).config.bots[0].items[0];
  assert.equal(item.payloadBytes, Buffer.byteLength(PAYLOAD));
  assert.equal(item.payload, undefined);
  assert.equal(item.description, "desc");
  assert.equal(saved.body.includes(PAYLOAD), false);
  assert.equal(JSON.stringify(t.sellerStore.state.config).includes(PAYLOAD), true, "stored for the job");
});

test("POST validation limits", async () => {
  const t = await setup();
  const bad = async (mutate, field) => {
    const input = draft();
    mutate(input);
    const response = await t.send("/admin/seller-bots", "POST", { body: input });
    assert.equal(response.statusCode, 400, field);
    assert.equal(body(response).field, field);
  };
  const item = (input) => input.bots[0].items[0];
  await bad((i) => { item(i).description = "x".repeat(1201); }, "description");
  await bad((i) => { item(i).description = "é".repeat(601); }, "description"); // 1202 bytes
  await bad((i) => { item(i).description = " "; }, "description");
  await bad((i) => { item(i).payload = "x".repeat(2001); }, "payload");
  await bad((i) => { item(i).payload = "é".repeat(1001); }, "payload"); // 2002 bytes
  await bad((i) => { delete item(i).payload; }, "payload");
  await bad((i) => { item(i).minimumBid = 0; }, "minimumBid");
  await bad((i) => { item(i).minimumBid = 1_000_000_001; }, "minimumBid");
  await bad((i) => { item(i).durationMinutes = 0; }, "durationMinutes");
  await bad((i) => { item(i).durationMinutes = 31; }, "durationMinutes");
  await bad((i) => { item(i).quantity = 0; }, "quantity");
  await bad((i) => { item(i).quantity = 51; }, "quantity");
  await bad((i) => { i.bots[0].spacingSeconds = 29; }, "spacingSeconds");
  await bad((i) => { i.bots[0].maxConcurrentOpen = 6; }, "maxConcurrentOpen");
  await bad((i) => { i.bots[0].maxConcurrentOpen = 0; }, "maxConcurrentOpen");
  await bad((i) => { i.bots[0].minNativeBalance = -1; }, "minNativeBalance");
  await bad((i) => { i.bots[0].id = "bot-9"; }, "unknown bot");
  await bad((i) => { i.presenceMode = "never"; }, "presenceMode");
  await bad((i) => { i.minActiveParticipants = 0; }, "minActiveParticipants");
  await bad((i) => { i.version = "0"; }, "version");
  const edge = draft();
  Object.assign(item(edge), { description: "d".repeat(1200), payload: "p".repeat(2000), minimumBid: 1_000_000_000, durationMinutes: 30, quantity: 50 });
  edge.bots[0].spacingSeconds = 30; edge.bots[0].maxConcurrentOpen = 5; edge.bots[0].minNativeBalance = 0;
  assert.equal((await t.send("/admin/seller-bots", "POST", { body: edge })).statusCode, 200, "the limits themselves are allowed");
  assert.equal((await t.send("/admin/seller-bots", "POST", { body: { ...draft(), version: 1 }, headers: {} })).statusCode, 200);
});

test("version conflict: a stale save is refused with 409 and the current version", async () => {
  const t = await setup();
  assert.equal((await t.send("/admin/seller-bots", "POST", { body: draft() })).statusCode, 200);
  const stale = await t.send("/admin/seller-bots", "POST", { body: draft({ version: 0 }) });
  assert.equal(stale.statusCode, 409);
  assert.equal(body(stale).version, 1);
  assert.equal((await t.send("/admin/seller-bots", "POST", { body: draft({ version: 1 }) })).statusCode, 200);
  assert.equal(t.sellerStore.state.version, 2);
});

test("write-only payload: an empty payload keeps the stored one, a new one replaces it, a new item needs one", async () => {
  const t = await setup();
  await t.send("/admin/seller-bots", "POST", { body: draft() });
  const keep = draft({ version: 1 });
  Object.assign(keep.bots[0].items[0], { slot: 1, payload: "", description: "edited" });
  assert.equal((await t.send("/admin/seller-bots", "POST", { body: keep })).statusCode, 200);
  assert.equal(t.sellerStore.state.config.bots[0].items[0].payload, PAYLOAD);
  assert.equal(t.sellerStore.state.config.bots[0].items[0].description, "edited");
  const replace = draft({ version: 2 });
  Object.assign(replace.bots[0].items[0], { slot: 1, payload: "new payload" });
  await t.send("/admin/seller-bots", "POST", { body: replace });
  assert.equal(t.sellerStore.state.config.bots[0].items[0].payload, "new payload");
  const fresh = draft({ version: 3 });
  fresh.bots[0].items.push({ description: "second", payload: "", minimumBid: 1, durationMinutes: 1, quantity: 1 });
  Object.assign(fresh.bots[0].items[0], { slot: 1, payload: "" });
  const refused = await t.send("/admin/seller-bots", "POST", { body: fresh });
  assert.equal(refused.statusCode, 400);
  assert.equal(body(refused).field, "payload");
  assert.equal(t.logs.join("\n").includes("new payload"), false);
});

test("slots are assigned by the server and stay stable; resetProgress moves seqBase past used numbers", async () => {
  const t = await setup();
  await t.send("/admin/seller-bots", "POST", { body: draft() });
  assert.equal(t.sellerStore.state.config.bots[0].items[0].slot, 1);
  const next = draft({ version: 1 });
  Object.assign(next.bots[0].items[0], { slot: 1, payload: "", resetProgress: true });
  await t.send("/admin/seller-bots", "POST", { body: next });
  assert.equal(t.sellerStore.state.config.bots[0].items[0].seqBase, 3);
  assert.equal(t.sellerStore.state.config.nextSlot, 2);
  const forged = draft({ version: 2 });
  forged.bots[0].items[0].slot = 77;
  assert.equal((await t.send("/admin/seller-bots", "POST", { body: forged })).statusCode, 400);
});

test("a paused bot keeps its lastError until the admin switches it on again", async () => {
  const t = await setup();
  t.sellerStore.state.config = makeConfig({ bots: [makeBot({ running: false, lastError: "rpc", items: [makeItem()] })] });
  t.sellerStore.state.version = 4;
  const view = body(await t.send("/admin/seller-bots", "GET"));
  assert.equal(view.config.bots[0].lastError, "rpc");
  const input = draft({ version: 4 });
  input.bots[0].running = false; Object.assign(input.bots[0].items[0], { slot: 1, payload: "" });
  await t.send("/admin/seller-bots", "POST", { body: input });
  assert.equal(t.sellerStore.state.config.bots[0].lastError, "rpc");
  input.version = 5; input.bots[0].running = true;
  await t.send("/admin/seller-bots", "POST", { body: input });
  assert.equal(t.sellerStore.state.config.bots[0].lastError, undefined);
});

test("stop-all switches the whole thing off", async () => {
  const t = await setup();
  await t.send("/admin/seller-bots", "POST", { body: draft({ enabled: true }) });
  assert.equal(t.sellerStore.state.config.enabled, true);
  const response = await t.send("/admin/seller-bots/stop-all", "POST", { body: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(t.sellerStore.state.config.enabled, false);
  assert.ok(t.sellerStore.state.config.bots[0].running, "bot settings are kept");
  assert.equal(t.logs.some((line) => JSON.parse(line).event === "admin_seller_bots_stopped"), true);
});

test("wrong methods answer 405", async () => {
  const t = await setup();
  assert.equal((await t.send("/admin/seller-bots/stop-all", "GET")).statusCode, 405);
  assert.equal((await t.send("/admin/seller-bots", "DELETE")).statusCode, 405);
});

test("the fund route is disabled (404) unless SELLER_FUNDING_MAX_WEI > 0", async () => {
  const off = await setup();
  assert.equal((await off.send("/admin/seller-bots/fund", "POST", { body: { botId: "bot-1", amountWei: "1" } })).statusCode, 404);
  assert.equal(loadConfig({ CHAIN_ID: "23293", FAUCET_AMOUNT_WEI: "1" }).sellerFundingMaxWei, 0n, "default 0");
  assert.equal(body(await off.send("/admin/seller-bots", "GET")).fundingEnabled, false);
});

test("fund route: caps per call and per day, only known bots, only the faucet wallet", async () => {
  const t = await setup({ config: { sellerFundingMaxWei: 2n * 10n ** 18n, sellerFundingDailyMaxWei: 3n * 10n ** 18n } });
  const sent = [];
  t.chain.sendRaw = async (raw) => { sent.push(raw); };
  const fund = (botId, amountWei, extra = {}) => t.send("/admin/seller-bots/fund", "POST", { body: { botId, amountWei }, ...extra });
  assert.equal((await fund("bot-1", "1")).statusCode, 200);
  assert.equal((await fund("nobody", "1")).statusCode, 400);
  assert.equal((await fund("__proto__", "1")).statusCode, 400);
  assert.equal((await fund("bot-1", "0")).statusCode, 400);
  assert.equal((await fund("bot-1", (2n * 10n ** 18n + 1n).toString())).statusCode, 400, "over the per-call cap");
  assert.equal((await fund("bot-1", (2n * 10n ** 18n).toString())).statusCode, 200, "2 TEST + 1 wei is within the 3 TEST day cap");
  assert.equal((await fund("bot-2", (10n ** 18n).toString())).statusCode, 429, "another TEST passes the day cap");
  assert.equal(sent.length, 2);
  const tx = Transaction.from(sent[0]);
  assert.equal(tx.from, faucetWallet.address, "paid by the faucet wallet");
  assert.equal(tx.to, ADDRESS["bot-1"]);
  t.chain.sendRaw = async () => { throw new Error("rpc down"); };
  assert.equal((await fund("bot-2", "1")).statusCode, 500);
  t.chain.sendRaw = async (raw) => { sent.push(raw); };
  assert.equal((await fund("bot-2", (10n ** 18n - 1n).toString())).statusCode, 200, "the failed broadcast gave its amount back to the day budget");
});
