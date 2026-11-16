"use strict";
// DynamoDB store for the faucet. Two tables, each with hash key `pk` (S) and TTL attribute `expiresAt`:
//   FAUCET table (codes)     pid#<sha256(pid)> items only. Never contains an IP, hashed or not.
//   RATE table (throttling)  rl#<scope>#<window> counters only. Never contains or references a pid.
// They are separate so that caller records and participant codes can never be joined.
//   pid#<sha256(pid)>   { status: unclaimed | pending | paid, address?, rawTx?, txHash?, leaseUntil?, paidAt?, amountWei? }
//   config#faucet       { open, updatedAt }          (open/closed switch)
//   counter#payouts     { count }                    (payout slots in use, prolific cap)
//   config#maxPayouts   { value, updatedAt }         (admin-managed cap; falls back to FAUCET_MAX_PAYOUTS when missing)
//   inbox#<sha256(pid)> { messages, acked, v, expiresAt }    (admin messages to one participant; see inbox.js)
//   config#broadcast    { messages, v, expiresAt }           (admin message to everybody; see inbox.js)
//   rl#<scope>#<window> { count, expiresAt }                     (RATE table; expires by TTL, ~11 minutes)
// Every state change is a conditional write, so parallel requests cannot both win.
// The same contract is implemented in memory by memoryStore.js for tests.
const stateKey = (pidHash) => ({ pk: { S: `pid#${pidHash}` } });
// Shared items in the codes table (no pid, no caller inside): the open/closed switch and the payout-slot counter.
const CONFIG_KEY = { pk: { S: "config#faucet" } };   // { open: BOOL, updatedAt: N }
const BUDGET_KEY = { pk: { S: "counter#payouts" } }; // { count: N }
const LIMIT_KEY = { pk: { S: "config#maxPayouts" } }; // { value: N }  admin-managed payout cap (overrides the deploy-time value)

const fromItem = (item) => {
  if (!item) return null;
  const read = (name) => item[name]?.S ?? (item[name]?.N !== undefined ? Number(item[name].N) : undefined);
  return {
    status: read("status"), address: read("address"), rawTx: read("rawTx"), txHash: read("txHash"),
    leaseUntil: read("leaseUntil"), paidAt: read("paidAt"), amountWei: read("amountWei"),
    slot: item.slot?.BOOL === true, // holds one slot of the payout cap (prolific mode)
  };
};

const sweepKey = (address) => ({ pk: { S: `sweep#${String(address).toLowerCase()}` } });
const SWEEP_SETTINGS_KEY = { pk: { S: "config#sweep" } }; // { idleMinutes, updatedAt }
const SWEEP_TTL_SECONDS = 14 * 24 * 3600; // records vanish by DynamoDB TTL after two weeks without a heartbeat
const SWEEP_STRINGS = ["address", "pidHash", "rawTx", "value", "status", "txHash", "returnedWei", "error"];
const SWEEP_NUMBERS = ["nonce", "signedAt", "lastSeen", "sendingAt", "sentAt", "confirmedAt", "attempts"];
const fromSweepItem = (item) => {
  if (!item) return null;
  const record = {};
  for (const name of SWEEP_STRINGS) if (item[name]?.S !== undefined) record[name] = item[name].S;
  for (const name of SWEEP_NUMBERS) if (item[name]?.N !== undefined) record[name] = Number(item[name].N);
  return record;
};
const toSweepItem = (record) => {
  const item = { ...sweepKey(record.address) };
  for (const name of SWEEP_STRINGS) if (record[name] !== undefined && record[name] !== null) item[name] = { S: String(record[name]) };
  for (const name of SWEEP_NUMBERS) if (record[name] !== undefined && record[name] !== null) item[name] = { N: String(record[name]) };
  item.expiresAt = { N: String((record.lastSeen || Math.floor(Date.now() / 1000)) + SWEEP_TTL_SECONDS) };
  return item;
};

const inboxKey = (pidHash) => ({ pk: { S: `inbox#${pidHash}` } });
const BROADCAST_KEY = { pk: { S: "config#broadcast" } };
const parseList = (attribute) => { try { const list = JSON.parse(attribute?.S || "[]"); return Array.isArray(list) ? list : []; } catch { return []; } };
const fromInboxItem = (item, pidHash) => (item ? { pidHash, messages: parseList(item.messages), acked: parseList(item.acked), v: Number(item.v?.N || 0) } : null);

const isConditionFailure = (error) => error?.name === "ConditionalCheckFailedException";

const createDynamoStore = ({ table, rateTable, client } = {}) => {
  // Lazily required: the Lambda nodejs20 runtime provides the SDK; tests inject `client` or use memoryStore.
  const sdk = require("@aws-sdk/client-dynamodb");
  const dynamo = client || new sdk.DynamoDBClient({});
  const send = (command) => dynamo.send(command);

  const store = {
    async get(pidHash) {
      return fromItem((await send(new sdk.GetItemCommand({ TableName: table, Key: stateKey(pidHash), ConsistentRead: true }))).Item);
    },
    // Allowlist insert (used by the pid generator). Never overwrites an existing pid.
    async putPid(pidHash, createdAt) {
      try {
        await send(new sdk.PutItemCommand({
          TableName: table,
          Item: { ...stateKey(pidHash), status: { S: "unclaimed" }, createdAt: { N: String(createdAt) } },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    async reserve(pidHash, address, nowSeconds, leaseUntil) {
      try {
        const result = await send(new sdk.UpdateItemCommand({
          TableName: table,
          Key: stateKey(pidHash),
          // A stale pending item can only be resumed by the SAME address its transaction was signed for,
          // and the stored address is never overwritten (it is set on the first reservation only).
          ConditionExpression: "attribute_exists(pk) AND (#s = :unclaimed OR (#s = :pending AND leaseUntil < :now AND address = :address))",
          UpdateExpression: "SET #s = :pending, leaseUntil = :lease, address = if_not_exists(address, :address)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":unclaimed": { S: "unclaimed" }, ":pending": { S: "pending" }, ":now": { N: String(nowSeconds) },
            ":address": { S: address.toLowerCase() }, ":lease": { N: String(leaseUntil) },
          },
          ReturnValues: "ALL_OLD",
        }));
        const previous = fromItem(result.Attributes);
        return { outcome: "reserved", previous: previous?.status === "pending" ? previous : null };
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        const record = await store.get(pidHash);
        if (!record) return { outcome: "unknown" };
        if (record.status === "paid") return { outcome: "paid", record };
        if (record.status === "pending" && record.leaseUntil < nowSeconds && record.address !== address.toLowerCase()) return { outcome: "mismatch" };
        return { outcome: "busy" };
      }
    },
    async savePending(pidHash, { rawTx, txHash }) {
      await send(new sdk.UpdateItemCommand({
        TableName: table, Key: stateKey(pidHash),
        ConditionExpression: "#s = :pending",
        UpdateExpression: "SET rawTx = :raw, txHash = :hash",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pending": { S: "pending" }, ":raw": { S: rawTx }, ":hash": { S: txHash } },
      }));
    },
    async markPaid(pidHash, { txHash, amountWei, paidAt }) {
      await send(new sdk.UpdateItemCommand({
        TableName: table, Key: stateKey(pidHash),
        ConditionExpression: "#s = :pending",
        UpdateExpression: "SET #s = :paid, txHash = :hash, amountWei = :amount, paidAt = :at REMOVE rawTx, leaseUntil",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pending": { S: "pending" }, ":paid": { S: "paid" }, ":hash": { S: txHash },
          ":amount": { S: amountWei }, ":at": { N: String(paidAt) },
        },
      }));
    },
    async release(pidHash) {
      const result = await send(new sdk.UpdateItemCommand({
        TableName: table, Key: stateKey(pidHash),
        ConditionExpression: "#s = :pending",
        UpdateExpression: "SET #s = :unclaimed REMOVE rawTx, txHash, leaseUntil, address, slot",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pending": { S: "pending" }, ":unclaimed": { S: "unclaimed" } },
        ReturnValues: "ALL_OLD",
      }));
      // A released reservation must not consume a payout slot: give it back (only if it held one).
      if (result?.Attributes?.slot?.BOOL === true) {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: BUDGET_KEY,
          UpdateExpression: "ADD #c :minus", ExpressionAttributeNames: { "#c": "count" }, ExpressionAttributeValues: { ":minus": { N: "-1" } },
        }));
      }
    },
    // Atomically takes one payout slot for a pending pid. Returns false when the cap is reached.
    // Step 1 is a conditional atomic increment (never above max); step 2 marks the pid as holding the slot.
    // A crash between the steps can only leak a slot (the cap then trips early), never exceed it.
    async takeSlot(pidHash, max) {
      try {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: BUDGET_KEY,
          ConditionExpression: "attribute_not_exists(#c) OR #c < :max",
          UpdateExpression: "ADD #c :one", ExpressionAttributeNames: { "#c": "count" },
          ExpressionAttributeValues: { ":one": { N: "1" }, ":max": { N: String(max) } },
        }));
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
      try {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: stateKey(pidHash),
          ConditionExpression: "#s = :pending AND attribute_not_exists(slot)",
          UpdateExpression: "SET slot = :yes",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pending": { S: "pending" }, ":yes": { BOOL: true } },
        }));
      } catch (error) {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: BUDGET_KEY,
          UpdateExpression: "ADD #c :minus", ExpressionAttributeNames: { "#c": "count" }, ExpressionAttributeValues: { ":minus": { N: "-1" } },
        }));
        throw error;
      }
      return true;
    },
    // Open/closed switch. Missing item = never opened = closed.
    async getState() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: CONFIG_KEY, ConsistentRead: true }))).Item;
      if (!item) return null;
      return { open: item.open?.BOOL === true, updatedAt: item.updatedAt?.N !== undefined ? Number(item.updatedAt.N) : null };
    },
    async setState(open, updatedAt) {
      await send(new sdk.UpdateItemCommand({
        TableName: table, Key: CONFIG_KEY,
        UpdateExpression: "SET #o = :open, updatedAt = :at", ExpressionAttributeNames: { "#o": "open" },
        ExpressionAttributeValues: { ":open": { BOOL: Boolean(open) }, ":at": { N: String(updatedAt) } },
      }));
    },
    // Payout slots in use (the same counter takeSlot increments).
    async getPayoutCount() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: BUDGET_KEY, ConsistentRead: true }))).Item;
      return item?.count?.N !== undefined ? Number(item.count.N) : 0;
    },
    // Admin-managed payout cap. null = never set (the deploy-time FAUCET_MAX_PAYOUTS applies).
    async getMaxPayouts() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: LIMIT_KEY, ConsistentRead: true }))).Item;
      return item?.value?.N !== undefined ? Number(item.value.N) : null;
    },
    // Atomic against the payout counter without needing extra IAM actions (no transaction): write the cap, then
    // re-read the counter. If slots in use already exceed the new cap (a claim took one in between), the write is rolled
    // back (only while it is still our value) and false is returned. Resolves true when the cap was set.
    async setMaxPayouts(value, updatedAt) {
      const result = await send(new sdk.UpdateItemCommand({
        TableName: table, Key: LIMIT_KEY,
        UpdateExpression: "SET #v = :value, updatedAt = :at", ExpressionAttributeNames: { "#v": "value" },
        ExpressionAttributeValues: { ":value": { N: String(value) }, ":at": { N: String(updatedAt) } },
        ReturnValues: "ALL_OLD",
      }));
      if ((await store.getPayoutCount()) <= value) return true;
      const before = result?.Attributes;
      try {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: LIMIT_KEY,
          ConditionExpression: "#v = :value",
          ...(before?.value
            ? { UpdateExpression: "SET #v = :previous, updatedAt = :at", ExpressionAttributeValues: { ":value": { N: String(value) }, ":previous": before.value, ":at": before.updatedAt || { N: String(updatedAt) } } }
            : { UpdateExpression: "REMOVE #v, updatedAt", ExpressionAttributeValues: { ":value": { N: String(value) } } }),
          ExpressionAttributeNames: { "#v": "value" },
        }));
      } catch (error) {
        if (!isConditionFailure(error)) throw error; // someone else changed the cap meanwhile: leave theirs
      }
      return false;
    },
    // ---- auto-return (sweep) records: item sweep#<address> in the codes table ----
    async getSweep(address) {
      return fromSweepItem((await send(new sdk.GetItemCommand({ TableName: table, Key: sweepKey(address), ConsistentRead: true }))).Item);
    },
    // Replaces the record unless a NEWER one (larger signedAt) is stored. Returns false when ignored.
    async putSweep(address, record) {
      try {
        await send(new sdk.PutItemCommand({
          TableName: table, Item: toSweepItem({ ...record, address }),
          ConditionExpression: "attribute_not_exists(pk) OR signedAt <= :signedAt",
          ExpressionAttributeValues: { ":signedAt": { N: String(record.signedAt) } },
        }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    // Heartbeat: refreshes lastSeen when the record exists for this pid. Returns the status or null.
    async touchSweep(address, pidHash, lastSeen) {
      try {
        const result = await send(new sdk.UpdateItemCommand({
          TableName: table, Key: sweepKey(address),
          ConditionExpression: "pidHash = :pid",
          UpdateExpression: "SET lastSeen = :seen, expiresAt = :exp",
          ExpressionAttributeValues: { ":pid": { S: pidHash }, ":seen": { N: String(lastSeen) }, ":exp": { N: String(lastSeen + SWEEP_TTL_SECONDS) } },
          ReturnValues: "ALL_NEW",
        }));
        return result.Attributes?.status?.S ?? "none";
      } catch (error) {
        if (isConditionFailure(error)) return null;
        throw error;
      }
    },
    // Scan of the sweep items only (the table is small: one item per participant plus the pid allowlist).
    async listSweeps() {
      const out = [];
      let startKey;
      do {
        const page = await send(new sdk.ScanCommand({
          TableName: table, ExclusiveStartKey: startKey,
          FilterExpression: "begins_with(pk, :prefix)", ExpressionAttributeValues: { ":prefix": { S: "sweep#" } },
        }));
        for (const item of page.Items || []) out.push(fromSweepItem(item));
        startKey = page.LastEvaluatedKey;
      } while (startKey && out.length < 2000);
      return out;
    },
    // Also requires lastSeen < idleBefore: a heartbeat between the scan and this claim cancels the broadcast.
    async claimSweep(address, signedAt, nowSeconds, sendingBefore, idleBefore) {
      try {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: sweepKey(address),
          ConditionExpression: "signedAt = :signed AND lastSeen < :idleBefore AND (#s = :armed OR (#s = :sending AND sendingAt < :before))",
          UpdateExpression: "SET #s = :sending, sendingAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":signed": { N: String(signedAt) }, ":armed": { S: "armed" }, ":sending": { S: "sending" },
            ":before": { N: String(sendingBefore) }, ":now": { N: String(nowSeconds) }, ":idleBefore": { N: String(idleBefore) },
          },
        }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    // Conditional on signedAt: a re-arm in the meantime wins. null values remove the field.
    async finishSweep(address, signedAt, fields) {
      const sets = [];
      const removes = [];
      const names = {};
      const values = { ":signed": { N: String(signedAt) } };
      let index = 0;
      for (const [name, value] of Object.entries(fields)) {
        if (![...SWEEP_STRINGS, ...SWEEP_NUMBERS].includes(name)) continue;
        const placeholder = `#f${index}`;
        names[placeholder] = name;
        if (value === null || value === undefined) removes.push(placeholder);
        else {
          sets.push(`${placeholder} = :v${index}`);
          values[`:v${index}`] = SWEEP_NUMBERS.includes(name) ? { N: String(value) } : { S: String(value) };
        }
        index += 1;
      }
      try {
        await send(new sdk.UpdateItemCommand({
          TableName: table, Key: sweepKey(address),
          ConditionExpression: "signedAt = :signed",
          UpdateExpression: [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" "),
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    async getSweepSettings() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: SWEEP_SETTINGS_KEY, ConsistentRead: true }))).Item;
      return item?.idleMinutes?.N !== undefined ? { idleMinutes: Number(item.idleMinutes.N), updatedAt: item.updatedAt?.N ? Number(item.updatedAt.N) : null } : null;
    },
    async setSweepSettings(idleMinutes, updatedAt) {
      await send(new sdk.UpdateItemCommand({
        TableName: table, Key: SWEEP_SETTINGS_KEY,
        UpdateExpression: "SET idleMinutes = :m, updatedAt = :at",
        ExpressionAttributeValues: { ":m": { N: String(idleMinutes) }, ":at": { N: String(updatedAt) } },
      }));
    },
    // ---- admin messages (inbox) ----
    async getInbox(pidHash) {
      return fromInboxItem((await send(new sdk.GetItemCommand({ TableName: table, Key: inboxKey(pidHash), ConsistentRead: true }))).Item, pidHash);
    },
    // Writes { messages, acked } if the stored version is still `expectedV` (0 = no item yet). Returns false on a lost race.
    async putInbox(pidHash, { messages, acked }, expectedV, expiresAt) {
      try {
        await send(new sdk.PutItemCommand({
          TableName: table,
          Item: { ...inboxKey(pidHash), messages: { S: JSON.stringify(messages) }, acked: { S: JSON.stringify(acked || []) }, v: { N: String(expectedV + 1) }, expiresAt: { N: String(expiresAt) } },
          ...(expectedV ? { ConditionExpression: "v = :v", ExpressionAttributeValues: { ":v": { N: String(expectedV) } } } : { ConditionExpression: "attribute_not_exists(pk)" }),
        }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    async getBroadcast() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: BROADCAST_KEY, ConsistentRead: true }))).Item;
      return item ? { messages: parseList(item.messages), v: Number(item.v?.N || 0) } : null;
    },
    async putBroadcast({ messages }, expectedV, expiresAt) {
      try {
        await send(new sdk.PutItemCommand({
          TableName: table,
          Item: { ...BROADCAST_KEY, messages: { S: JSON.stringify(messages) }, v: { N: String(expectedV + 1) }, expiresAt: { N: String(expiresAt) } },
          ...(expectedV ? { ConditionExpression: "v = :v", ExpressionAttributeValues: { ":v": { N: String(expectedV) } } } : { ConditionExpression: "attribute_not_exists(pk)" }),
        }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    // Scan of the inbox items only (admin history).
    async listInboxes() {
      const out = [];
      let startKey;
      do {
        const page = await send(new sdk.ScanCommand({
          TableName: table, ExclusiveStartKey: startKey,
          FilterExpression: "begins_with(pk, :prefix)", ExpressionAttributeValues: { ":prefix": { S: "inbox#" } },
        }));
        for (const item of page.Items || []) out.push(fromInboxItem(item, item.pk.S.slice("inbox#".length)));
        startKey = page.LastEvaluatedKey;
      } while (startKey && out.length < 2000);
      return out;
    },
    // Atomic counter per (scope, window); the item expires by TTL.
    async hit(scope, windowId, expiresAt, by = 1) {
      if (!rateTable || rateTable === table) throw new Error("hit() needs a rateTable that differs from the codes table");
      const result = await send(new sdk.UpdateItemCommand({
        TableName: rateTable,
        Key: { pk: { S: `rl#${scope}#${windowId}` } },
        UpdateExpression: "ADD #c :by SET expiresAt = :exp",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":by": { N: String(by) }, ":exp": { N: String(expiresAt) } },
        ReturnValues: "UPDATED_NEW",
      }));
      return Number(result.Attributes.count.N);
    },
  };
  return store;
};

module.exports = { createDynamoStore };
