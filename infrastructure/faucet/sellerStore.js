"use strict";
// Store for the seller bots (same DynamoDB table as the faucet, new item types only; memory twin for tests).
//   config#sellerbots           { data: JSON config, version }   admin-owned; optimistic concurrency on `version`
//   progress#sellerbots         { data: JSON progress }          job-owned (written under the lease)
//   lease#sellerjob             { holder, leaseUntil }
//   sellerbot#<bot>#item#<slot>#seq#<n>   one auction attempt (status sending|created|released), unique by conditional put
//   fund#<yyyy-mm-dd>           { total }                        wei funded that UTC day (fund route)
// Presence is read from the existing sweep#<address> items (lastSeen, seconds).
const configKey = { pk: { S: "config#sellerbots" } };
const progressKey = { pk: { S: "progress#sellerbots" } };
const leaseKey = { pk: { S: "lease#sellerjob" } };
const recordPk = (botId, item, seq) => `sellerbot#${botId}#item#${item}#seq#${seq}`;
const RECORD_STRINGS = ["botId", "status", "txHash", "auction"];
const RECORD_NUMBERS = ["item", "seq", "nonce", "endTime", "createdAt", "sendingAt"];
const RECORD_BOOLS = ["finalized"];
const isConditionFailure = (error) => error?.name === "ConditionalCheckFailedException";
const parse = (text, fallback) => { try { const value = JSON.parse(text); return value && typeof value === "object" ? value : fallback; } catch { return fallback; } };

const fromRecord = (item) => {
  if (!item) return null;
  const out = {};
  for (const name of RECORD_STRINGS) if (item[name]?.S !== undefined) out[name] = item[name].S;
  for (const name of RECORD_NUMBERS) if (item[name]?.N !== undefined) out[name] = Number(item[name].N);
  for (const name of RECORD_BOOLS) if (item[name]?.BOOL !== undefined) out[name] = item[name].BOOL;
  return out;
};
const toValue = (name, value) => (RECORD_NUMBERS.includes(name) ? { N: String(value) } : RECORD_BOOLS.includes(name) ? { BOOL: Boolean(value) } : { S: String(value) });

const createDynamoSellerStore = ({ table, client } = {}) => {
  const sdk = require("@aws-sdk/client-dynamodb");
  const dynamo = client || new sdk.DynamoDBClient({});
  const send = (command) => dynamo.send(command);
  const conditional = async (command) => {
    try { await send(command); return true; } catch (error) { if (isConditionFailure(error)) return false; throw error; }
  };
  return {
    async getConfig() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: configKey, ConsistentRead: true }))).Item;
      return item ? { config: parse(item.data?.S, null), version: Number(item.version?.N || 0) } : null;
    },
    // expectedVersion 0 = no item yet. Returns false on a lost race.
    putConfig(config, expectedVersion) {
      return conditional(new sdk.PutItemCommand({
        TableName: table,
        Item: { ...configKey, data: { S: JSON.stringify(config) }, version: { N: String(expectedVersion + 1) } },
        ...(expectedVersion ? { ConditionExpression: "version = :v", ExpressionAttributeValues: { ":v": { N: String(expectedVersion) } } } : { ConditionExpression: "attribute_not_exists(pk)" }),
      }));
    },
    async getProgress() {
      const item = (await send(new sdk.GetItemCommand({ TableName: table, Key: progressKey, ConsistentRead: true }))).Item;
      return item ? parse(item.data?.S, {}) : {};
    },
    async putProgress(progress) {
      await send(new sdk.PutItemCommand({ TableName: table, Item: { ...progressKey, data: { S: JSON.stringify(progress) } } }));
    },
    acquireLease(holder, nowSeconds, leaseUntil) {
      return conditional(new sdk.PutItemCommand({
        TableName: table, Item: { ...leaseKey, holder: { S: holder }, leaseUntil: { N: String(leaseUntil) } },
        ConditionExpression: "attribute_not_exists(pk) OR leaseUntil < :now", ExpressionAttributeValues: { ":now": { N: String(nowSeconds) } },
      }));
    },
    async releaseLease(holder) {
      await conditional(new sdk.UpdateItemCommand({
        TableName: table, Key: leaseKey, ConditionExpression: "holder = :h", UpdateExpression: "SET leaseUntil = :zero",
        ExpressionAttributeValues: { ":h": { S: holder }, ":zero": { N: "0" } },
      }));
    },
    // Participants seen since `sinceSeconds` (sweep heartbeat items), excluding `exclude` addresses. Throws on a scan error.
    async countPresence({ sinceSeconds, exclude = new Set() }) {
      let count = 0;
      let startKey;
      do {
        const page = await send(new sdk.ScanCommand({
          TableName: table, ExclusiveStartKey: startKey,
          FilterExpression: "begins_with(pk, :prefix) AND lastSeen >= :since",
          ProjectionExpression: "pk, lastSeen",
          ExpressionAttributeValues: { ":prefix": { S: "sweep#" }, ":since": { N: String(sinceSeconds) } },
        }));
        for (const item of page.Items || []) if (!exclude.has(String(item.pk.S).slice("sweep#".length).toLowerCase())) count += 1;
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return count;
    },
    async getRecord(botId, item, seq) {
      return fromRecord((await send(new sdk.GetItemCommand({ TableName: table, Key: { pk: { S: recordPk(botId, item, seq) } }, ConsistentRead: true }))).Item);
    },
    // attribute_not_exists: the quantity guard. Returns false when the sequence number is taken.
    createRecord(record) {
      const Item = { pk: { S: recordPk(record.botId, record.item, record.seq) } };
      for (const [name, value] of Object.entries(record)) if (value !== undefined && value !== null) Item[name] = toValue(name, value);
      return conditional(new sdk.PutItemCommand({ TableName: table, Item, ConditionExpression: "attribute_not_exists(pk)" }));
    },
    // Sets fields, optionally only while the status is `expectStatus`.
    updateRecord(botId, item, seq, fields, expectStatus) {
      const names = { "#st": "status" };
      const values = {};
      const sets = [];
      let index = 0;
      for (const [name, value] of Object.entries(fields)) {
        names[`#f${index}`] = name; values[`:v${index}`] = toValue(name, value); sets.push(`#f${index} = :v${index}`); index += 1;
      }
      if (expectStatus) values[":expect"] = { S: expectStatus };
      return conditional(new sdk.UpdateItemCommand({
        TableName: table, Key: { pk: { S: recordPk(botId, item, seq) } },
        ConditionExpression: expectStatus ? "#st = :expect" : "attribute_exists(pk)", UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      }));
    },
    // Adds `amountWei` to today's funded total unless that would pass `maxPerDayWei`. Returns false when over the cap.
    async addFunding(day, amountWei, maxPerDayWei) {
      const room = BigInt(maxPerDayWei) - BigInt(amountWei);
      if (room < 0n) return false;
      return conditional(new sdk.UpdateItemCommand({
        TableName: table, Key: { pk: { S: `fund#${day}` } },
        ConditionExpression: "attribute_not_exists(#t) OR #t <= :room", UpdateExpression: "ADD #t :amount SET expiresAt = :exp",
        ExpressionAttributeNames: { "#t": "total" },
        ExpressionAttributeValues: { ":amount": { N: String(amountWei) }, ":room": { N: room.toString() }, ":exp": { N: String(Math.floor(Date.now() / 1000) + 3 * 86400) } },
      }));
    },
    async refundFunding(day, amountWei) {
      await send(new sdk.UpdateItemCommand({
        TableName: table, Key: { pk: { S: `fund#${day}` } }, UpdateExpression: "ADD #t :minus",
        ExpressionAttributeNames: { "#t": "total" }, ExpressionAttributeValues: { ":minus": { N: `-${String(amountWei)}` } },
      }));
    },
  };
};

// In-memory twin. `sweepSeen` (address -> lastSeen seconds) stands in for the sweep#<address> items; `failScan` simulates a scan error.
const createMemorySellerStore = () => {
  const state = { config: null, version: 0, progress: {}, lease: null, records: new Map(), funding: new Map(), sweepSeen: new Map(), failScan: false, calls: { countPresence: 0, getProgress: 0 } };
  const key = (botId, item, seq) => recordPk(botId, item, seq);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    state,
    async getConfig() { await tick(); return state.config ? { config: structuredClone(state.config), version: state.version } : null; },
    async putConfig(config, expectedVersion) {
      await tick();
      if (state.version !== expectedVersion) return false;
      state.config = structuredClone(config); state.version += 1; return true;
    },
    async getProgress() { await tick(); state.calls.getProgress += 1; return structuredClone(state.progress); },
    async putProgress(progress) { await tick(); state.progress = structuredClone(progress); },
    async acquireLease(holder, nowSeconds, leaseUntil) {
      await tick();
      if (state.lease && !(state.lease.leaseUntil < nowSeconds)) return false;
      state.lease = { holder, leaseUntil }; return true;
    },
    async releaseLease(holder) { await tick(); if (state.lease?.holder === holder) state.lease.leaseUntil = 0; },
    async countPresence({ sinceSeconds, exclude = new Set() }) {
      await tick();
      state.calls.countPresence += 1;
      if (state.failScan) throw new Error("scan failed");
      let count = 0;
      for (const [address, lastSeen] of state.sweepSeen) if (lastSeen >= sinceSeconds && !exclude.has(address.toLowerCase())) count += 1;
      return count;
    },
    async getRecord(botId, item, seq) { await tick(); const record = state.records.get(key(botId, item, seq)); return record ? { ...record } : null; },
    async createRecord(record) {
      await tick();
      const id = key(record.botId, record.item, record.seq);
      if (state.records.has(id)) return false;
      state.records.set(id, { ...record }); return true;
    },
    async updateRecord(botId, item, seq, fields, expectStatus) {
      await tick();
      const record = state.records.get(key(botId, item, seq));
      if (!record || (expectStatus && record.status !== expectStatus)) return false;
      Object.assign(record, fields); return true;
    },
    async addFunding(day, amountWei, maxPerDayWei) {
      await tick();
      const total = state.funding.get(day) || 0n;
      if (total + BigInt(amountWei) > BigInt(maxPerDayWei)) return false;
      state.funding.set(day, total + BigInt(amountWei)); return true;
    },
    async refundFunding(day, amountWei) { await tick(); state.funding.set(day, (state.funding.get(day) || 0n) - BigInt(amountWei)); },
  };
};

module.exports = { createDynamoSellerStore, createMemorySellerStore, recordPk };
