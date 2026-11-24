// The DynamoDB seller store against a small fake client that understands exactly the expressions sellerStore.js sends.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createDynamoSellerStore } = require("../../infrastructure/faucet/sellerStore.js");

const conditionFailed = () => Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
const fakeDynamo = ({ pageSize = 2 } = {}) => {
  const items = new Map();
  const commands = [];
  return {
    items, commands,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      commands.push({ name, input });
      const key = input.Key?.pk?.S ?? input.Item?.pk?.S;
      const values = input.ExpressionAttributeValues || {};
      if (name === "GetItemCommand") return { Item: items.get(key) };
      if (name === "PutItemCommand") {
        const condition = input.ConditionExpression || "";
        const old = items.get(key);
        if (condition === "attribute_not_exists(pk)" && old) throw conditionFailed();
        if (condition === "version = :v" && Number(old?.version?.N) !== Number(values[":v"].N)) throw conditionFailed();
        if (condition.startsWith("attribute_not_exists(pk) OR leaseUntil") && old && !(Number(old.leaseUntil.N) < Number(values[":now"].N))) throw conditionFailed();
        items.set(key, structuredClone(input.Item));
        return {};
      }
      if (name === "UpdateItemCommand") {
        const old = items.get(key);
        const condition = input.ConditionExpression || "";
        if (condition === "holder = :h") { if (old?.holder?.S !== values[":h"].S) throw conditionFailed(); old.leaseUntil = values[":zero"]; return {}; }
        if (condition === "#st = :expect") { if (old?.status?.S !== values[":expect"].S) throw conditionFailed(); }
        else if (condition === "attribute_exists(pk)") { if (!old) throw conditionFailed(); }
        else if (condition.includes("#t <= :room")) {
          if (old && !(Number(old.total.N) <= Number(values[":room"].N))) throw conditionFailed();
          const total = BigInt(old?.total?.N || 0) + BigInt(values[":amount"].N);
          items.set(key, { ...(old || { pk: { S: key } }), total: { N: total.toString() } });
          return {};
        } else if (input.UpdateExpression.startsWith("ADD")) {
          old.total = { N: (BigInt(old.total.N) + BigInt(values[":minus"].N)).toString() };
          return {};
        }
        for (const match of input.UpdateExpression.replace(/^SET /, "").split(", ")) {
          const [n, v] = match.split(" = ");
          old[input.ExpressionAttributeNames[n]] = values[v];
        }
        return {};
      }
      if (name === "ScanCommand") {
        assert.equal(input.FilterExpression, "begins_with(pk, :prefix) AND lastSeen >= :since");
        assert.equal(input.ProjectionExpression, "pk, lastSeen");
        const all = [...items.values()].filter((item) => item.pk.S.startsWith("sweep#") && Number(item.lastSeen?.N) >= Number(values[":since"].N));
        const start = Number(input.ExclusiveStartKey?.i || 0);
        const page = all.slice(start, start + pageSize);
        return { Items: page.map((item) => ({ pk: item.pk, lastSeen: item.lastSeen })), LastEvaluatedKey: start + pageSize < all.length ? { i: start + pageSize } : undefined };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
};
const sweep = (address, lastSeen) => ({ pk: { S: `sweep#${address}` }, lastSeen: { N: String(lastSeen) }, status: { S: "armed" } });

test("presence count: window boundary, bot exclusion, non-sweep items ignored, paginated", async () => {
  const client = fakeDynamo();
  for (const [address, seen] of [["0xaa", 1000], ["0xbb", 999], ["0xcc", 1500], ["0xdd", 2000], ["0xbot", 1800]]) client.items.set(`sweep#${address}`, sweep(address, seen));
  client.items.set("pid#abc", { pk: { S: "pid#abc" }, lastSeen: { N: "5000" } });
  client.items.set("config#faucet", { pk: { S: "config#faucet" }, lastSeen: { N: "5000" } });
  const store = createDynamoSellerStore({ table: "T", client });
  assert.equal(await store.countPresence({ sinceSeconds: 1000, exclude: new Set(["0xbot"]) }), 3, "1000 counts (>=), 999 does not, the bot does not");
  assert.equal(await store.countPresence({ sinceSeconds: 1001 }), 3);
  assert.ok(client.commands.filter((c) => c.name === "ScanCommand").length >= 4, "followed LastEvaluatedKey");
});

test("a scan error propagates (the job reads it as unknown presence)", async () => {
  const store = createDynamoSellerStore({ table: "T", client: { send: async () => { throw new Error("throttled"); } } });
  await assert.rejects(() => store.countPresence({ sinceSeconds: 1 }));
});

test("records: attribute_not_exists guard, conditional status updates", async () => {
  const store = createDynamoSellerStore({ table: "T", client: fakeDynamo() });
  const record = { botId: "bot-1", item: 1, seq: 1, status: "sending", createdAt: 5, sendingAt: 5 };
  assert.equal(await store.createRecord(record), true);
  assert.equal(await store.createRecord(record), false, "the same sequence number cannot be taken twice");
  assert.equal(await store.updateRecord("bot-1", 1, 1, { status: "created" }, "released"), false);
  assert.equal(await store.updateRecord("bot-1", 1, 1, { status: "created", auction: "0x1", endTime: 9 }, "sending"), true);
  assert.deepEqual(await store.getRecord("bot-1", 1, 1), { ...record, status: "created", auction: "0x1", endTime: 9 });
  assert.equal(await store.getRecord("bot-1", 1, 2), null);
});

test("config: optimistic version; lease: one holder until expiry; funding: per-day cap", async () => {
  const store = createDynamoSellerStore({ table: "T", client: fakeDynamo() });
  assert.equal(await store.getConfig(), null);
  assert.equal(await store.putConfig({ a: 1 }, 0), true);
  assert.equal(await store.putConfig({ a: 2 }, 0), false);
  assert.equal(await store.putConfig({ a: 3 }, 1), true);
  assert.deepEqual(await store.getConfig(), { config: { a: 3 }, version: 2 });
  assert.equal(await store.acquireLease("a", 100, 250), true);
  assert.equal(await store.acquireLease("b", 200, 350), false);
  assert.equal(await store.acquireLease("b", 251, 400), true);
  await store.releaseLease("a"); // not the holder: no effect
  assert.equal(await store.acquireLease("c", 300, 450), false);
  await store.releaseLease("b");
  assert.equal(await store.acquireLease("c", 300, 450), true);
  assert.equal(await store.addFunding("2026-01-01", 5n, 10n), true);
  assert.equal(await store.addFunding("2026-01-01", 5n, 10n), true);
  assert.equal(await store.addFunding("2026-01-01", 1n, 10n), false);
  await store.refundFunding("2026-01-01", 5n);
  assert.equal(await store.addFunding("2026-01-01", 5n, 10n), true);
});
