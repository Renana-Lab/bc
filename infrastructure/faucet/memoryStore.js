"use strict";
// In-memory implementation of the faucet store contract (see store.js). TEST ONLY: it mirrors the
// DynamoDB conditional-write semantics, with a small async delay so parallel requests interleave.
const tick = () => new Promise((resolve) => setImmediate(resolve));

const createMemoryStore = () => {
  const pids = new Map();
  const counters = new Map(); // key -> { count, expiresAt }  (rate-limit records; no pid inside)
  const shared = { state: null, budget: 0 }; // open/closed switch and the payout-slot counter
  return {
    pids,
    counters,
    shared,
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
      if (record.slot) shared.budget -= 1; // a released reservation gives its payout slot back
      pids.set(pidHash, { status: "unclaimed", createdAt: record.createdAt });
    },
    // Atomically takes one payout slot for a pending pid (false when the cap is reached).
    async takeSlot(pidHash, max) {
      await tick();
      const record = pids.get(pidHash);
      if (record?.status !== "pending" || record.slot) throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
      if (shared.budget >= max) return false;
      shared.budget += 1;
      pids.set(pidHash, { ...record, slot: true });
      return true;
    },
    async getState() {
      await tick();
      return shared.state ? { ...shared.state } : null;
    },
    async setState(open, updatedAt) {
      await tick();
      shared.state = { open: Boolean(open), updatedAt };
    },
    async hit(scope, windowId, expiresAt, by = 1) {
      await tick();
      const key = `${scope}#${windowId}`;
      const record = counters.get(key) || { count: 0, expiresAt };
      record.count += by;
      record.expiresAt = expiresAt;
      counters.set(key, record);
      return record.count;
    },
  };
};

module.exports = { createMemoryStore };
