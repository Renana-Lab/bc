// Tests the DynamoDB store's command construction and result handling against a small fake DynamoDB
// client. The fake understands exactly the expressions store.js sends, so this checks the store's
// logic and its mapping to the shared contract; it does NOT prove real DynamoDB semantics (no AWS
// or DynamoDB Local is available here).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createDynamoStore } = require("../../infrastructure/faucet/store.js");

const conditionFailed = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
const str = (value) => value?.S;
const num = (value) => (value?.N !== undefined ? Number(value.N) : undefined);

const fakeDynamo = () => {
  const items = new Map();
  const commands = [];
  return {
    items, commands,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      commands.push({ name, input });
      const key = input.Key?.pk?.S ?? input.Item?.pk?.S;
      const item = items.get(key);
      const values = input.ExpressionAttributeValues || {};
      if (name === "GetItemCommand") return { Item: item ? structuredClone(item) : undefined };
      if (name === "PutItemCommand") {
        if (input.ConditionExpression === "attribute_not_exists(pk)" && item) throw conditionFailed();
        items.set(key, structuredClone(input.Item));
        return {};
      }
      if (name !== "UpdateItemCommand") throw new Error(`unexpected command ${name}`);
      const update = input.UpdateExpression;
      if (update.startsWith("ADD")) {
        const next = (num(item?.count) || 0) + 1;
        items.set(key, { pk: { S: key }, count: { N: String(next) }, expiresAt: values[":exp"] });
        return { Attributes: { count: { N: String(next) } } };
      }
      const status = str(item?.status);
      if (update.includes("if_not_exists(address")) { // reserve
        const resumable = status === "pending" && num(item.leaseUntil) < num(values[":now"]) && str(item.address) === str(values[":address"]);
        if (!item || !(status === "unclaimed" || resumable)) throw conditionFailed();
        const old = structuredClone(item);
        items.set(key, { ...item, status: { S: "pending" }, leaseUntil: values[":lease"], address: item.address ?? values[":address"] });
        return { Attributes: old };
      }
      if (status !== "pending") throw conditionFailed(); // savePending, markPaid, release all require `pending`
      if (update.startsWith("SET rawTx")) items.set(key, { ...item, rawTx: values[":raw"], txHash: values[":hash"] });
      else if (update.includes(":paid")) {
        const { rawTx, leaseUntil, ...rest } = item;
        items.set(key, { ...rest, status: { S: "paid" }, txHash: values[":hash"], amountWei: values[":amount"], paidAt: values[":at"] });
      } else if (update.includes(":unclaimed")) items.set(key, { pk: item.pk, status: { S: "unclaimed" }, createdAt: item.createdAt });
      else throw new Error(`unexpected update ${update}`);
      return {};
    },
  };
};

const NOW = 1_700_000_000;

test("dynamo store: allowlist insert never overwrites; reserve is exclusive; payment is recorded once", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "t", client });
  assert.equal(await store.putPid("h1", NOW), true);
  assert.equal(await store.putPid("h1", NOW), false, "existing code is not overwritten");
  assert.deepEqual(await store.reserve("nope", "0xAbc0000000000000000000000000000000000001", NOW, NOW + 60), { outcome: "unknown" });

  const address = "0xAbC0000000000000000000000000000000000001";
  const first = await store.reserve("h1", address, NOW, NOW + 60);
  assert.deepEqual(first, { outcome: "reserved", previous: null });
  assert.equal((await store.reserve("h1", address, NOW + 10, NOW + 70)).outcome, "busy");

  await store.savePending("h1", { rawTx: "0xraw", txHash: "0xhash" });
  await store.markPaid("h1", { txHash: "0xhash", amountWei: "100", paidAt: NOW + 5 });
  const paid = await store.reserve("h1", address, NOW + 200, NOW + 260);
  assert.equal(paid.outcome, "paid");
  assert.equal(paid.record.txHash, "0xhash");
  assert.equal(paid.record.address, address.toLowerCase());
  assert.equal(paid.record.rawTx, undefined, "raw transaction removed once paid");
  await assert.rejects(store.markPaid("h1", { txHash: "0xother", amountWei: "1", paidAt: NOW }), /conditional/i, "cannot be paid twice");
});

test("dynamo store: an expired lease resumes only for the same address and keeps the stored transaction", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "t", client });
  await store.putPid("h2", NOW);
  const a = "0x00000000000000000000000000000000000000aa";
  const b = "0x00000000000000000000000000000000000000bb";
  await store.reserve("h2", a, NOW, NOW + 60);
  await store.savePending("h2", { rawTx: "0xraw", txHash: "0xhash" });
  assert.equal((await store.reserve("h2", a, NOW + 30, NOW + 90)).outcome, "busy", "lease still live");
  assert.equal((await store.reserve("h2", b, NOW + 100, NOW + 160)).outcome, "mismatch", "other address after expiry");
  assert.equal(str(client.items.get("pid#h2").address), a, "address never overwritten");
  const resumed = await store.reserve("h2", a, NOW + 100, NOW + 160);
  assert.equal(resumed.outcome, "reserved");
  assert.equal(resumed.previous.rawTx, "0xraw");
  assert.equal(resumed.previous.txHash, "0xhash");
  await store.release("h2");
  assert.equal(client.items.get("pid#h2").status.S, "unclaimed");
  assert.equal(client.items.get("pid#h2").address, undefined, "release clears the address");
  assert.equal((await store.reserve("h2", b, NOW + 200, NOW + 260)).outcome, "reserved", "usable again after release");
});

test("dynamo store: rate-limit counters and consistent reads", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "t", client });
  assert.equal(await store.hit("ip:abc", 7, NOW + 1200), 1);
  assert.equal(await store.hit("ip:abc", 7, NOW + 1200), 2);
  assert.equal(await store.hit("ip:abc", 8, NOW + 1800), 1, "new window starts again");
  await store.putPid("h3", NOW);
  await store.get("h3");
  assert.equal(client.commands.at(-1).input.ConsistentRead, true);
  const reserve = client.commands.find((c) => c.input.ConditionExpression?.includes(":unclaimed"));
  assert.ok(reserve === undefined || reserve.input.ExpressionAttributeNames["#s"] === "status", "reserved word aliased");
});
