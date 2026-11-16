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

// Evaluates exactly the sweep expressions store.js sends (touch, claim, finish).
const sweepUpdate = (items, key, item, input, values) => {
  const condition = input.ConditionExpression || "";
  if (!item) throw conditionFailed();
  const status = str(item.status);
  if (condition === "pidHash = :pid") { // touchSweep
    if (str(item.pidHash) !== str(values[":pid"])) throw conditionFailed();
    items.set(key, { ...item, lastSeen: values[":seen"], expiresAt: values[":exp"] });
    return { Attributes: structuredClone(items.get(key)) };
  }
  if (condition.includes("lastSeen < :idleBefore")) { // claimSweep
    const ok = num(item.signedAt) === Number(values[":signed"].N) && num(item.lastSeen) < Number(values[":idleBefore"].N)
      && (status === "armed" || (status === "sending" && num(item.sendingAt) < Number(values[":before"].N)));
    if (!ok) throw conditionFailed();
    items.set(key, { ...item, status: { S: "sending" }, sendingAt: values[":now"] });
    return {};
  }
  if (condition === "signedAt = :signed") { // finishSweep: SET #f0 = :v0, ... REMOVE #f1
    if (num(item.signedAt) !== Number(values[":signed"].N)) throw conditionFailed();
    const next = { ...item };
    const names = input.ExpressionAttributeNames;
    const [setPart, removePart] = input.UpdateExpression.split("REMOVE");
    for (const match of (setPart.replace(/^\s*SET/, "").match(/#f\d+ = :v\d+/g) || [])) { const [n, v] = match.split(" = "); next[names[n]] = values[v]; }
    for (const n of (removePart || "").match(/#f\d+/g) || []) delete next[names[n]];
    items.set(key, next);
    return {};
  }
  throw new Error(`unexpected sweep update ${input.UpdateExpression}`);
};

const fakeDynamo = () => {
  const tables = new Map();
  const tableOf = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const commands = [];
  return {
    tableOf, commands,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      commands.push({ name, input });
      const items = tableOf(input.TableName);
      const key = input.Key?.pk?.S ?? input.Item?.pk?.S;
      const item = items.get(key);
      const values = input.ExpressionAttributeValues || {};
      if (name === "ScanCommand") { // sweep listing: begins_with(pk, :prefix)
        return { Items: [...items.entries()].filter(([k]) => k.startsWith(values[":prefix"].S)).map(([, v]) => structuredClone(v)) };
      }
      if (key?.startsWith("sweep#") && name === "PutItemCommand") { // putSweep: attribute_not_exists(pk) OR signedAt <= :signedAt
        if (item && !(num(item.signedAt) <= Number(values[":signedAt"].N))) throw conditionFailed();
        items.set(key, structuredClone(input.Item));
        return {};
      }
      if (key?.startsWith("sweep#") && name === "UpdateItemCommand") return sweepUpdate(items, key, item, input, values);
      if (name === "GetItemCommand") return { Item: item ? structuredClone(item) : undefined };
      if (name === "PutItemCommand") {
        if (input.ConditionExpression === "attribute_not_exists(pk)" && item) throw conditionFailed();
        items.set(key, structuredClone(input.Item));
        return {};
      }
      if (name !== "UpdateItemCommand") throw new Error(`unexpected command ${name}`);
      const update = input.UpdateExpression;
      if (key === "counter#payouts") { // payout-slot counter: conditional increment / decrement
        const current = num(item?.count) || 0;
        if (input.ConditionExpression && current >= Number(values[":max"].N)) throw conditionFailed();
        const next = current + Number((values[":one"] || values[":minus"]).N);
        items.set(key, { pk: { S: key }, count: { N: String(next) } });
        return {};
      }
      if (key === "config#maxPayouts") { // admin-managed cap: set, and conditional rollback
        if (input.ConditionExpression && num(item?.value) !== Number(values[":value"].N)) throw conditionFailed();
        const old = item ? structuredClone(item) : undefined;
        if (update.startsWith("REMOVE")) items.delete(key);
        else items.set(key, { pk: { S: key }, value: values[":previous"] || values[":value"], updatedAt: values[":at"] });
        return input.ReturnValues === "ALL_OLD" ? { Attributes: old } : {};
      }
      if (key === "config#faucet") { // open/closed switch
        items.set(key, { pk: { S: key }, open: values[":open"], updatedAt: values[":at"] });
        return {};
      }
      if (update.startsWith("ADD")) {
        const next = (num(item?.count) || 0) + Number(values[":by"].N);
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
      if (update === "SET slot = :yes") {
        if (item.slot) throw conditionFailed();
        items.set(key, { ...item, slot: values[":yes"] });
      } else if (update.startsWith("SET rawTx")) items.set(key, { ...item, rawTx: values[":raw"], txHash: values[":hash"] });
      else if (update.includes(":paid")) {
        const { rawTx, leaseUntil, ...rest } = item;
        items.set(key, { ...rest, status: { S: "paid" }, txHash: values[":hash"], amountWei: values[":amount"], paidAt: values[":at"] });
      } else if (update.includes(":unclaimed")) {
        items.set(key, { pk: item.pk, status: { S: "unclaimed" }, createdAt: item.createdAt });
        return input.ReturnValues === "ALL_OLD" ? { Attributes: structuredClone(item) } : {};
      } else throw new Error(`unexpected update ${update}`);
      return {};
    },
  };
};

const NOW = 1_700_000_000;

test("dynamo store: allowlist insert never overwrites; reserve is exclusive; payment is recorded once", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
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
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  await store.putPid("h2", NOW);
  const a = "0x00000000000000000000000000000000000000aa";
  const b = "0x00000000000000000000000000000000000000bb";
  await store.reserve("h2", a, NOW, NOW + 60);
  await store.savePending("h2", { rawTx: "0xraw", txHash: "0xhash" });
  assert.equal((await store.reserve("h2", a, NOW + 30, NOW + 90)).outcome, "busy", "lease still live");
  assert.equal((await store.reserve("h2", b, NOW + 100, NOW + 160)).outcome, "mismatch", "other address after expiry");
  assert.equal(str(client.tableOf("codes").get("pid#h2").address), a, "address never overwritten");
  const resumed = await store.reserve("h2", a, NOW + 100, NOW + 160);
  assert.equal(resumed.outcome, "reserved");
  assert.equal(resumed.previous.rawTx, "0xraw");
  assert.equal(resumed.previous.txHash, "0xhash");
  await store.release("h2");
  assert.equal(client.tableOf("codes").get("pid#h2").status.S, "unclaimed");
  assert.equal(client.tableOf("codes").get("pid#h2").address, undefined, "release clears the address");
  assert.equal((await store.reserve("h2", b, NOW + 200, NOW + 260)).outcome, "reserved", "usable again after release");
});

test("dynamo store: rate-limit counters and consistent reads", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  assert.equal(await store.hit("ip:abc", 7, NOW + 1200), 1);
  assert.equal(await store.hit("ip:abc", 7, NOW + 1200), 2);
  assert.equal(await store.hit("ip:abc", 8, NOW + 1800), 1, "new window starts again");
  await store.putPid("h3", NOW);
  await store.get("h3");
  assert.equal(client.commands.at(-1).input.ConsistentRead, true);
  const reserve = client.commands.find((c) => c.input.ConditionExpression?.includes(":unclaimed"));
  assert.ok(reserve === undefined || reserve.input.ExpressionAttributeNames["#s"] === "status", "reserved word aliased");
});

test("dynamo store: rate-limit records go to a separate table and never touch the codes table", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  await store.putPid("h9", NOW);
  await store.reserve("h9", "0x00000000000000000000000000000000000000cc", NOW, NOW + 60);
  await store.hit("ip:somehmac", 3, NOW + 660);
  await store.hit("global", 3, NOW + 660);
  for (const key of client.tableOf("codes").keys()) assert.match(key, /^pid#/, "codes table holds code items only");
  for (const [key, item] of client.tableOf("rates")) {
    assert.match(key, /^rl#/, "rate table holds counters only");
    assert.deepEqual(Object.keys(item).sort(), ["count", "expiresAt", "pk"], "no other attributes (no pid, no ip)");
  }
  for (const command of client.commands) {
    if (command.name === "UpdateItemCommand" && command.input.UpdateExpression.startsWith("ADD")) assert.equal(command.input.TableName, "rates");
    else assert.equal(command.input.TableName, "codes");
  }
  await assert.rejects(createDynamoStore({ table: "codes", client }).hit("x", 1, 1), /rateTable/);
});

test("dynamo store: payout slots are capped atomically and a release gives the slot back", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  const address = "0x00000000000000000000000000000000000000dd";
  for (const hash of ["s1", "s2", "s3"]) { await store.putPid(hash, NOW); await store.reserve(hash, address, NOW, NOW + 60); }
  assert.equal(await store.takeSlot("s1", 2), true);
  assert.equal(await store.takeSlot("s2", 2), true);
  assert.equal(await store.takeSlot("s3", 2), false, "cap reached");
  assert.equal(num(client.tableOf("codes").get("counter#payouts").count), 2);
  assert.equal((await store.reserve("s1", address, NOW + 100, NOW + 160)).previous.slot, true);
  await store.release("s3");
  assert.equal(num(client.tableOf("codes").get("counter#payouts").count), 2, "releasing a pid without a slot changes nothing");
  await store.release("s1");
  assert.equal(num(client.tableOf("codes").get("counter#payouts").count), 1, "released reservation returned its slot");
  assert.equal(client.tableOf("codes").get("pid#s1").slot, undefined);
});

test("dynamo store: the open/closed switch defaults to closed and stores only open and updatedAt", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  assert.equal(await store.getState(), null);
  await store.setState(true, NOW);
  assert.deepEqual(await store.getState(), { open: true, updatedAt: NOW });
  await store.setState(false, NOW + 5);
  assert.deepEqual(await store.getState(), { open: false, updatedAt: NOW + 5 });
  assert.deepEqual(Object.keys(client.tableOf("codes").get("config#faucet")).sort(), ["open", "pk", "updatedAt"]);
});

test("dynamo store: getPayoutCount reads the slot counter with a consistent read (0 when never used)", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  assert.equal(await store.getPayoutCount(), 0);
  assert.deepEqual(client.commands.at(-1).input.Key, { pk: { S: "counter#payouts" } });
  assert.equal(client.commands.at(-1).input.ConsistentRead, true);
  assert.equal(client.commands.at(-1).input.TableName, "codes");
  const address = "0x00000000000000000000000000000000000000ee";
  await store.putPid("c1", NOW); await store.reserve("c1", address, NOW, NOW + 60); await store.takeSlot("c1", 5);
  assert.equal(await store.getPayoutCount(), 1);
});

test("dynamo store: getMaxPayouts is null until set, reads config#maxPayouts consistently, and returns a number", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  assert.equal(await store.getMaxPayouts(), null);
  assert.deepEqual(client.commands.at(-1).input.Key, { pk: { S: "config#maxPayouts" } });
  assert.equal(client.commands.at(-1).input.ConsistentRead, true);
  assert.equal(await store.setMaxPayouts(40, NOW), true);
  assert.equal(await store.getMaxPayouts(), 40);
});

test("dynamo store: setMaxPayouts writes only config#maxPayouts { value, updatedAt } on the codes table", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  assert.equal(await store.setMaxPayouts(25, NOW), true);
  const write = client.commands.find((c) => c.name === "UpdateItemCommand" && c.input.Key.pk.S === "config#maxPayouts");
  assert.equal(write.input.TableName, "codes");
  assert.deepEqual(write.input.ExpressionAttributeValues, { ":value": { N: "25" }, ":at": { N: String(NOW) } });
  assert.deepEqual(Object.keys(client.tableOf("codes").get("config#maxPayouts")).sort(), ["pk", "updatedAt", "value"]);
  assert.equal(await store.setMaxPayouts(30, NOW + 5), true, "raising and lowering above the used count work");
  assert.equal(await store.getMaxPayouts(), 30);
});

test("dynamo store: setMaxPayouts refuses a value below the slots in use and rolls the write back", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  client.tableOf("codes").set("counter#payouts", { pk: { S: "counter#payouts" }, count: { N: "5" } });
  assert.equal(await store.setMaxPayouts(3, NOW), false);
  assert.equal(await store.getMaxPayouts(), null, "nothing stored when there was no previous cap");
  assert.equal(await store.setMaxPayouts(8, NOW + 1), true);
  assert.equal(await store.setMaxPayouts(4, NOW + 2), false);
  assert.equal(await store.getMaxPayouts(), 8, "the previous cap is restored");
  assert.equal(await store.setMaxPayouts(5, NOW + 3), true, "equal to the slots in use is allowed");
});

test("dynamo store: a claim that takes a slot while the cap is being lowered makes the lowering fail", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  client.tableOf("codes").set("counter#payouts", { pk: { S: "counter#payouts" }, count: { N: "2" } });
  const realSend = client.send.bind(client);
  client.send = async (command) => {
    const result = await realSend(command);
    if (command.input.Key?.pk?.S === "config#maxPayouts" && command.input.ReturnValues === "ALL_OLD") {
      client.tableOf("codes").set("counter#payouts", { pk: { S: "counter#payouts" }, count: { N: "3" } }); // a claim wins the race
    }
    return result;
  };
  assert.equal(await store.setMaxPayouts(2, NOW), false, "the counter is re-checked after the write");
  assert.equal(await store.getMaxPayouts(), null);
});

test("dynamo store: the rollback is conditional - a concurrent write by someone else is not clobbered", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  assert.equal(await store.setMaxPayouts(8, NOW), true);
  client.tableOf("codes").set("counter#payouts", { pk: { S: "counter#payouts" }, count: { N: "6" } });
  const realSend = client.send.bind(client);
  client.send = async (command) => {
    const result = await realSend(command);
    if (command.input.Key?.pk?.S === "config#maxPayouts" && command.input.ReturnValues === "ALL_OLD") {
      // another admin saves 20 between our write (4) and our rollback
      client.tableOf("codes").set("config#maxPayouts", { pk: { S: "config#maxPayouts" }, value: { N: "20" }, updatedAt: { N: String(NOW + 9) } });
    }
    return result;
  };
  assert.equal(await store.setMaxPayouts(4, NOW + 1), false, "6 slots are in use, 4 is refused");
  assert.equal(await store.getMaxPayouts(), 20, "the other admin's value survives");
  const rollback = client.commands.filter((c) => c.name === "UpdateItemCommand" && c.input.Key.pk.S === "config#maxPayouts").at(-1);
  assert.equal(rollback.input.ConditionExpression, "#v = :value", "rollback only applies while the value is still ours");
  assert.equal(rollback.input.ExpressionAttributeValues[":value"].N, "4");
});

test("dynamo store: sweep records - replace-if-newer, heartbeat, claim needs idleness, finish is conditional", async () => {
  const client = fakeDynamo();
  const store = createDynamoStore({ table: "codes", rateTable: "rates", client });
  const address = "0x00000000000000000000000000000000000000AA";
  const record = (signedAt, extra = {}) => ({ pidHash: "p1", rawTx: "0xraw", nonce: 0, value: "5", status: "armed", signedAt, lastSeen: NOW, ...extra });
  assert.equal(await store.putSweep(address, record(100)), true);
  assert.equal(await store.putSweep(address, record(90)), false, "an older signature never replaces a newer one");
  assert.equal(await store.putSweep(address, record(110, { value: "7" })), true);
  assert.equal((await store.getSweep(address)).value, "7");
  assert.equal((await store.listSweeps()).length, 1);

  assert.equal(await store.touchSweep(address, "wrong", NOW + 50), null, "needs the matching pid hash");
  assert.equal(await store.touchSweep(address, "p1", NOW + 50), "armed");
  assert.equal((await store.getSweep(address)).lastSeen, NOW + 50);

  const claim = (idleBefore) => store.claimSweep(address, 110, NOW + 5000, NOW + 4400, idleBefore);
  assert.equal(await claim(NOW + 50), false, "lastSeen is not older than idleBefore: a heartbeat cancels the claim");
  assert.equal(await store.claimSweep(address, 999, NOW + 5000, NOW + 4400, NOW + 4000), false, "a re-arm (other signedAt) cancels the claim");
  assert.equal(await claim(NOW + 4000), true);
  assert.equal((await store.getSweep(address)).status, "sending");
  assert.equal(await claim(NOW + 4000), false, "a second run cannot claim it again");

  assert.equal(await store.finishSweep(address, 999, { status: "stale" }), false, "finish is conditional on signedAt");
  assert.equal(await store.finishSweep(address, 110, { status: "sent", txHash: "0xh", sentAt: NOW + 5000, error: null, rawTx: null }), true);
  const done = await store.getSweep(address);
  assert.equal(done.status, "sent");
  assert.equal(done.txHash, "0xh");
  assert.equal(done.rawTx, undefined, "removed fields disappear");
});
