"use strict";
// DynamoDB store for the faucet. Two tables, each with hash key `pk` (S) and TTL attribute `expiresAt`:
//   FAUCET table (codes)     pid#<sha256(pid)> items only. Never contains an IP, hashed or not.
//   RATE table (throttling)  rl#<scope>#<window> counters only. Never contains or references a pid.
// They are separate so that caller records and participant codes can never be joined.
//   pid#<sha256(pid)>   { status: unclaimed | pending | paid, address?, rawTx?, txHash?, leaseUntil?, paidAt?, amountWei? }
//   rl#<scope>#<window> { count, expiresAt }                     (RATE table; expires by TTL, ~11 minutes)
// Every state change is a conditional write, so parallel requests cannot both win.
// The same contract is implemented in memory by memoryStore.js for tests.
const stateKey = (pidHash) => ({ pk: { S: `pid#${pidHash}` } });

const fromItem = (item) => {
  if (!item) return null;
  const read = (name) => item[name]?.S ?? (item[name]?.N !== undefined ? Number(item[name].N) : undefined);
  return {
    status: read("status"), address: read("address"), rawTx: read("rawTx"), txHash: read("txHash"),
    leaseUntil: read("leaseUntil"), paidAt: read("paidAt"), amountWei: read("amountWei"),
  };
};

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
      await send(new sdk.UpdateItemCommand({
        TableName: table, Key: stateKey(pidHash),
        ConditionExpression: "#s = :pending",
        UpdateExpression: "SET #s = :unclaimed REMOVE rawTx, txHash, leaseUntil, address",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pending": { S: "pending" }, ":unclaimed": { S: "unclaimed" } },
      }));
    },
    // Atomic counter per (scope, window); the item expires by TTL.
    async hit(scope, windowId, expiresAt) {
      if (!rateTable || rateTable === table) throw new Error("hit() needs a rateTable that differs from the codes table");
      const result = await send(new sdk.UpdateItemCommand({
        TableName: rateTable,
        Key: { pk: { S: `rl#${scope}#${windowId}` } },
        UpdateExpression: "ADD #c :one SET expiresAt = :exp",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":one": { N: "1" }, ":exp": { N: String(expiresAt) } },
        ReturnValues: "UPDATED_NEW",
      }));
      return Number(result.Attributes.count.N);
    },
  };
  return store;
};

module.exports = { createDynamoStore };
