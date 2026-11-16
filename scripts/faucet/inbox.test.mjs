// Admin-to-participant messages on the faucet server: admin send/history, participant inbox/ack (EIP-191 signed), caps, TTL, store contract.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Wallet } from "ethers";

const require = createRequire(import.meta.url);
const { createFaucetHandler, sha256 } = require("../../infrastructure/faucet/handler.js");
const { sweepMessage } = require("../../infrastructure/faucet/sweep.js");
const { TTL_SECONDS, MAX_DIRECT_MESSAGES, MAX_BROADCASTS } = require("../../infrastructure/faucet/inbox.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { createDynamoStore } = require("../../infrastructure/faucet/store.js");
const { hashPassword } = require("../../infrastructure/faucet/adminAuth.js");

const PASSWORD = "correct horse battery staple";
const faucetWallet = Wallet.createRandom();
const CONFIG = { chainId: 23293, amountWei: 10n ** 17n, rateLimit: 1000, globalRateLimit: 10000, rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 1000, absentChecks: 1, absentDelayMs: 0 };
const parse = (response) => JSON.parse(response.body);
const DAY = 24 * 3600 * 1000;

const setup = async ({ config = {} } = {}) => {
  const store = createMemoryStore();
  const clock = { ms: 1_700_000_000_000 };
  const logs = [];
  const record = await hashPassword(PASSWORD);
  const handler = createFaucetHandler({
    store, chain: {}, config: { ...CONFIG, ...config }, getPrivateKey: async () => faucetWallet.privateKey, getRateSalt: async () => "salt",
    getAdminSecret: async () => record, now: () => clock.ms, log: (line) => logs.push(line),
  });
  const send = (path, method, { body, headers, query, ip = "198.51.100.9" } = {}) => handler({
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body), headers, queryStringParameters: query, requestContext: { http: { method, sourceIp: ip } },
  });
  const admin = {
    send: (body, password = PASSWORD) => send("/admin/messages", "POST", { body, headers: password === null ? {} : { "x-admin-password": password } }),
    list: (query, password = PASSWORD) => send("/admin/messages", "GET", { query, headers: password === null ? {} : { "x-admin-password": password } }),
  };
  const participant = ({ paid = true } = {}) => {
    const wallet = Wallet.createRandom();
    const pidHash = sha256(`pid-${wallet.address}`);
    store.pids.set(pidHash, { status: paid ? "paid" : "unclaimed", ...(paid ? { address: wallet.address.toLowerCase(), txHash: "0x1", paidAt: Math.floor(clock.ms / 1000) - 60 } : {}) });
    const signed = async (action, ts = clock.ms, signer = wallet) => ({ ts, sig: await signer.signMessage(sweepMessage(action, wallet.address, pidHash, ts)) });
    const inbox = async (signer = wallet, ts = clock.ms) => {
      const { ts: t, sig } = await signed("inbox", ts, signer);
      return send("/inbox", "GET", { query: { pidHash, address: wallet.address, ts: String(t), sig } });
    };
    const ack = async (ids, signer = wallet, action = "ack") => send("/inbox/ack", "POST", { body: { pidHash, address: wallet.address, ids, ...(await signed(action, clock.ms, signer)) } });
    return { wallet, pidHash, inbox, ack, signed };
  };
  return { store, clock, logs, send, admin, participant };
};

test("admin sends to one participant; the participant reads it, acknowledges it, and the admin sees it as read", async () => {
  const t = await setup();
  const p = t.participant();
  const sent = await t.admin.send({ pidHash: p.pidHash, body: "  Please finish the questionnaire.  " });
  assert.equal(sent.statusCode, 200, sent.body);
  const { id } = parse(sent);

  const first = parse(await p.inbox());
  assert.deepEqual(first.messages.map((m) => [m.id, m.body]), [[id, "Please finish the questionnaire."]]);
  assert.equal(first.serverTime, t.clock.ms);

  let history = parse(await t.admin.list({ pidHash: p.pidHash }));
  assert.equal(history.participants[0].messages[0].readAt, null);

  t.clock.ms += 5000;
  const acked = await p.ack([id]);
  assert.equal(acked.statusCode, 200, acked.body);
  assert.equal(parse(acked).acked, 1);
  assert.deepEqual(parse(await p.inbox()).messages, [], "an acknowledged message is not delivered again");
  assert.equal((await p.ack([id])).statusCode, 200, "ack is idempotent");

  history = parse(await t.admin.list({ pidHash: p.pidHash }));
  assert.equal(history.participants[0].messages[0].body, "Please finish the questionnaire.");
  assert.equal(history.participants[0].messages[0].readAt, new Date(t.clock.ms).toISOString());
});

test("a broadcast reaches every participant once, is acknowledged per participant and counts readers", async () => {
  const t = await setup();
  const a = t.participant();
  const b = t.participant();
  assert.equal((await t.admin.send({ all: true, body: "Break in 5 minutes" })).statusCode, 200);
  const [ma, mb] = [parse(await a.inbox()).messages, parse(await b.inbox()).messages];
  assert.equal(ma.length, 1);
  assert.equal(mb[0].id, ma[0].id);
  await a.ack([ma[0].id]);
  assert.deepEqual(parse(await a.inbox()).messages, []);
  assert.equal(parse(await b.inbox()).messages.length, 1, "the other participant still has to read it");
  const history = parse(await t.admin.list());
  assert.equal(history.broadcasts[0].readCount, 1);
  assert.equal(parse(await t.admin.list({ pidHash: a.pidHash })).broadcasts[0].read, true);
  assert.equal(parse(await t.admin.list({ pidHash: b.pidHash })).broadcasts[0].read, false);
});

test("messages arrive oldest first; a broadcast sent before the participant was paid is not shown", async () => {
  const t = await setup();
  await t.admin.send({ all: true, body: "old news" });
  t.clock.ms += 10 * 60_000;
  const p = t.participant(); // paid a minute before "now"
  t.clock.ms += 1000;
  await t.admin.send({ pidHash: p.pidHash, body: "first" });
  t.clock.ms += 1000;
  await t.admin.send({ all: true, body: "second" });
  t.clock.ms += 1000;
  await t.admin.send({ pidHash: p.pidHash, body: "third" });
  assert.deepEqual(parse(await p.inbox()).messages.map((m) => m.body), ["first", "second", "third"]);
});

test("admin endpoints need the password; wrong passwords are rate limited", async () => {
  const t = await setup();
  const p = t.participant();
  assert.equal((await t.admin.send({ all: true, body: "x" }, null)).statusCode, 401);
  assert.equal((await t.admin.send({ all: true, body: "x" }, "wrong")).statusCode, 401);
  assert.equal((await t.admin.list(undefined, "wrong")).statusCode, 401);
  assert.equal((await t.send("/admin/messages", "POST", { body: { all: true, body: "x", password: PASSWORD } })).statusCode, 200, "the body password is accepted like the other admin posts");
  assert.equal((await t.admin.send({ pidHash: p.pidHash, body: "x" }, "wrong")).statusCode, 401);
  for (let i = 0; i < 6; i += 1) await t.admin.list(undefined, "wrong");
  assert.equal((await t.admin.list(undefined, PASSWORD)).statusCode, 429, "too many failures from one caller");
  assert.equal((await t.send("/admin/messages", "DELETE")).statusCode, 405);
});

test("admin input is validated: one target, 1-1000 characters, a known participant", async () => {
  const t = await setup();
  const p = t.participant();
  const status = async (body) => (await t.admin.send(body)).statusCode;
  assert.equal(await status({ body: "no target" }), 400);
  assert.equal(await status({ all: true, pidHash: p.pidHash, body: "two targets" }), 400);
  assert.equal(await status({ pidHash: p.pidHash, body: "   " }), 400);
  assert.equal(await status({ pidHash: p.pidHash, body: 42 }), 400);
  assert.equal(await status({ pidHash: p.pidHash, body: "x".repeat(1001) }), 400);
  assert.equal(await status({ pidHash: p.pidHash, body: "x".repeat(1000) }), 200);
  assert.equal(await status({ pidHash: "nothex", body: "hi" }), 400);
  assert.equal(await status({ pidHash: "a".repeat(64), body: "hi" }), 404, "no inbox is created for an id that never existed");
  assert.equal(t.store.inboxes.has("a".repeat(64)), false);
  assert.equal((await t.admin.list({ pidHash: "nope" })).statusCode, 400);
  const big = await t.admin.send({ all: true, body: "y".repeat(9000) });
  assert.equal(big.statusCode, 413);
});

test("control characters are stripped and the text is stored as sent otherwise (rendered as plain text by the client)", async () => {
  const t = await setup();
  const p = t.participant();
  await t.admin.send({ pidHash: p.pidHash, body: "line1\nline2\u0007 <b>bold</b>" });
  assert.equal(parse(await p.inbox()).messages[0].body, "line1\nline2 <b>bold</b>");
});

test("the participant must prove wallet ownership: wrong signer, wrong action, stale timestamp, other participant", async () => {
  const t = await setup();
  const p = t.participant();
  const other = t.participant();
  await t.admin.send({ pidHash: p.pidHash, body: "secret" });
  assert.equal((await p.inbox(Wallet.createRandom())).statusCode, 403, "a stranger's signature");
  assert.equal((await p.inbox(p.wallet, t.clock.ms - 6 * 60_000)).statusCode, 403, "a stale signature");
  const heartbeatSig = await p.signed("heartbeat");
  assert.equal((await t.send("/inbox", "GET", { query: { pidHash: p.pidHash, address: p.wallet.address, ts: String(heartbeatSig.ts), sig: heartbeatSig.sig } })).statusCode, 403, "a heartbeat signature is not an inbox signature");
  assert.equal((await p.ack(["whatever1"], p.wallet, "inbox")).statusCode, 403, "an inbox signature cannot ack");
  assert.equal((await p.ack(["whatever1"], Wallet.createRandom())).statusCode, 403);
  // other participant's wallet asking for p's pid hash
  const sig = await other.signed("inbox");
  const mismatched = await t.send("/inbox", "GET", { query: { pidHash: p.pidHash, address: other.wallet.address, ts: String(sig.ts), sig: (await other.wallet.signMessage(sweepMessage("inbox", other.wallet.address, p.pidHash, sig.ts))) } });
  assert.equal(mismatched.statusCode, 403);
  assert.equal(parse(mismatched).error, "not_eligible", "the pid is bound to another address");
  assert.equal((await t.send("/inbox", "GET", { query: { pidHash: "bad", address: p.wallet.address, ts: "1", sig: "0x" } })).statusCode, 400);
  assert.equal((await t.send("/inbox", "POST")).statusCode, 405);
  assert.equal((await t.send("/inbox/ack", "GET")).statusCode, 405);
  // none of the failures marked anything as read
  assert.equal((await t.store.getInbox(p.pidHash)).messages[0].readAt, undefined);
});

test("an unpaid participant has no inbox; ack validates its ids", async () => {
  const t = await setup();
  const unpaid = t.participant({ paid: false });
  assert.equal((await unpaid.inbox()).statusCode, 403);
  const p = t.participant();
  assert.equal((await p.ack([])).statusCode, 400);
  assert.equal((await p.ack(["bad id!"])).statusCode, 400);
  assert.equal((await p.ack(Array.from({ length: 21 }, (_, i) => `id-${i}-xxxxx`))).statusCode, 400);
  assert.equal((await t.send("/inbox/ack", "POST", { body: { pidHash: p.pidHash, address: p.wallet.address, ids: ["id-aaaaaaaa"], ...(await p.signed("ack")) }, ip: "9.9.9.9" })).statusCode, 200, "an unknown id is simply ignored");
});

test("lists are capped, messages expire, and the oldest are dropped first", async () => {
  const t = await setup();
  const p = t.participant();
  for (let i = 0; i < MAX_DIRECT_MESSAGES + 3; i += 1) { t.clock.ms += 1; await t.admin.send({ pidHash: p.pidHash, body: `m${i}` }); }
  const stored = (await t.store.getInbox(p.pidHash)).messages;
  assert.equal(stored.length, MAX_DIRECT_MESSAGES);
  assert.equal(stored[0].body, "m3");
  for (let i = 0; i < MAX_BROADCASTS + 2; i += 1) { t.clock.ms += 1; await t.admin.send({ all: true, body: `b${i}` }); }
  assert.equal((await t.store.getBroadcast()).messages.length, MAX_BROADCASTS);
  t.clock.ms += TTL_SECONDS * 1000 + DAY;
  assert.deepEqual(parse(await p.inbox()).messages, [], "expired messages are not delivered even before DynamoDB removes the item");
});

test("acknowledged broadcast ids that no longer exist are forgotten", async () => {
  const t = await setup();
  const p = t.participant();
  await t.admin.send({ all: true, body: "one" });
  const [first] = parse(await p.inbox()).messages;
  await p.ack([first.id]);
  for (let i = 0; i < MAX_BROADCASTS; i += 1) { t.clock.ms += 1; await t.admin.send({ all: true, body: `b${i}` }); }
  const [next] = parse(await p.inbox()).messages;
  await p.ack([next.id]);
  const { acked } = await t.store.getInbox(p.pidHash);
  assert.equal(acked.includes(first.id), false);
  assert.equal(acked.includes(next.id), true);
});

test("parallel sends and acks do not lose messages (optimistic writes retry)", async () => {
  const t = await setup({ config: { adminRateLimit: 100 } }); // the guard counts attempts in flight
  const p = t.participant();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => t.admin.send({ pidHash: p.pidHash, body: `parallel ${i}` })));
  assert.deepEqual(results.map((r) => r.statusCode), Array(8).fill(200));
  const messages = parse(await p.inbox()).messages;
  assert.equal(messages.length, 8);
  const acks = await Promise.all(messages.map((m) => p.ack([m.id])));
  assert.deepEqual(acks.map((r) => r.statusCode), Array(8).fill(200));
  assert.deepEqual(parse(await p.inbox()).messages, []);
});

test("inbox polling has its own rate limit and the logs never contain message text or the full pid hash", async () => {
  const t = await setup({ config: { inboxRateLimit: 3, inboxGlobalRateLimit: 100 } });
  const p = t.participant();
  await t.admin.send({ pidHash: p.pidHash, body: "very private text" });
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await p.inbox()).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const logged = t.logs.join("\n");
  assert.equal(logged.includes("very private text"), false);
  assert.equal(logged.includes(p.pidHash), false);
  assert.match(logged, /admin_message_sent/);
});

// ---- DynamoDB store contract against a small fake client (checks the expressions store.js sends, not real DynamoDB) ----
const conditionFailed = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
const fakeDynamo = () => {
  const items = new Map();
  return {
    items,
    async send(command) {
      const { input } = command;
      const name = command.constructor.name;
      if (name === "GetItemCommand") return { Item: items.get(input.Key.pk.S) };
      if (name === "PutItemCommand") {
        const existing = items.get(input.Item.pk.S);
        if (input.ConditionExpression === "attribute_not_exists(pk)" && existing) throw conditionFailed();
        if (input.ConditionExpression === "v = :v" && (!existing || existing.v.N !== input.ExpressionAttributeValues[":v"].N)) throw conditionFailed();
        items.set(input.Item.pk.S, structuredClone(input.Item));
        return {};
      }
      if (name === "ScanCommand") {
        const prefix = input.ExpressionAttributeValues[":prefix"].S;
        return { Items: [...items.values()].filter((item) => item.pk.S.startsWith(prefix)) };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
};

test("dynamo store: inbox and broadcast items are version-checked, carry a TTL and list by prefix", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  const hash = "ab".repeat(32);
  assert.equal(await store.getInbox(hash), null);
  const messages = [{ id: "m1-aaaaaaaa", body: "hello", createdAt: 5 }];
  assert.equal(await store.putInbox(hash, { messages, acked: [] }, 0, 999), true);
  assert.equal(await store.putInbox(hash, { messages: [], acked: [] }, 0, 999), false, "a second first-write loses");
  assert.deepEqual(await store.getInbox(hash), { pidHash: hash, messages, acked: [], v: 1 });
  assert.equal(client.items.get(`inbox#${hash}`).expiresAt.N, "999");
  assert.equal(await store.putInbox(hash, { messages, acked: ["b1-aaaaaaaa"] }, 1, 1000), true);
  assert.equal(await store.putInbox(hash, { messages, acked: [] }, 1, 1000), false, "a stale version loses");
  assert.deepEqual((await store.listInboxes()).map((r) => [r.pidHash, r.acked, r.v]), [[hash, ["b1-aaaaaaaa"], 2]]);

  assert.equal(await store.getBroadcast(), null);
  assert.equal(await store.putBroadcast({ messages }, 0, 5), true);
  assert.equal(await store.putBroadcast({ messages }, 0, 5), false);
  assert.equal(await store.putBroadcast({ messages: [] }, 1, 6), true);
  assert.deepEqual(await store.getBroadcast(), { messages: [], v: 2 });
  assert.equal(client.items.get("config#broadcast").expiresAt.N, "6");
  assert.equal((await store.listInboxes()).length, 1, "the broadcast item is not an inbox");
});
