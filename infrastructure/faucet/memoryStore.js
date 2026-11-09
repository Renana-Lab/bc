"use strict";
// In-memory implementation of the faucet store contract (see store.js). TEST ONLY: it mirrors the
// DynamoDB conditional-write semantics, with a small async delay so parallel requests interleave.
const tick = () => new Promise((resolve) => setImmediate(resolve));

const createMemoryStore = () => {
  const pids = new Map();
  const counters = new Map(); // key -> { count, expiresAt }  (rate-limit records; no pid inside)
  return {
    pids,
    counters,
    async get(pidHash) {
      await tick();
      const record = pids.get(pidHash);
      return record ? { ...record } : null;
    },
    async putPid(pidHash, createdAt) {
      await tick();
      if (pids.has(pidHash)) return false;
      pids.set(pidHash, { status: "unclaimed", createdAt });
      return true;
    },
    async reserve(pidHash, address, nowSeconds, leaseUntil) {
      await tick();
      const record = pids.get(pidHash);
      if (!record) return { outcome: "unknown" };
      if (record.status === "paid") return { outcome: "paid", record: { ...record } };
      if (record.status === "pending" && !(record.leaseUntil < nowSeconds)) return { outcome: "busy" };
      if (record.status === "pending" && record.address !== address.toLowerCase()) return { outcome: "mismatch" };
      const previous = record.status === "pending" ? { ...record } : null;
      pids.set(pidHash, { ...record, status: "pending", address: record.address ?? address.toLowerCase(), leaseUntil });
      return { outcome: "reserved", previous };
    },
    async savePending(pidHash, { rawTx, txHash }) {
      await tick();
      const record = pids.get(pidHash);
      if (record?.status !== "pending") throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
      pids.set(pidHash, { ...record, rawTx, txHash });
    },
    async markPaid(pidHash, { txHash, amountWei, paidAt }) {
      await tick();
      const record = pids.get(pidHash);
      if (record?.status !== "pending") throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
      const { rawTx, leaseUntil, ...rest } = record;
      pids.set(pidHash, { ...rest, status: "paid", txHash, amountWei, paidAt });
    },
    async release(pidHash) {
      await tick();
      const record = pids.get(pidHash);
      if (record?.status !== "pending") throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
      pids.set(pidHash, { status: "unclaimed", createdAt: record.createdAt });
    },
    async hit(scope, windowId, expiresAt) {
      await tick();
      const key = `${scope}#${windowId}`;
      const record = counters.get(key) || { count: 0, expiresAt };
      record.count += 1;
      record.expiresAt = expiresAt;
      counters.set(key, record);
      return record.count;
    },
  };
};

module.exports = { createMemoryStore };
