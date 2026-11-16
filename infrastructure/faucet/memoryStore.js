"use strict";
// In-memory implementation of the faucet store contract (see store.js). TEST ONLY: it mirrors the
// DynamoDB conditional-write semantics, with a small async delay so parallel requests interleave.
const tick = () => new Promise((resolve) => setImmediate(resolve));

const createMemoryStore = () => {
  const pids = new Map();
  const counters = new Map(); // key -> { count, expiresAt }  (rate-limit records; no pid inside)
  const shared = { state: null, budget: 0, maxPayouts: null, sweepSettings: null }; // open/closed switch and the payout-slot counter
  const sweeps = new Map(); // lowercase address -> sweep record (see sweep.js)
  return {
    pids,
    counters,
    shared,
    sweeps,
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
    async getPayoutCount() {
      await tick();
      return shared.budget;
    },
    async getMaxPayouts() {
      await tick();
      return shared.maxPayouts;
    },
    async setMaxPayouts(value) {
      await tick();
      if (shared.budget > value) return false; // never below the slots in use
      shared.maxPayouts = value;
      return true;
    },
    // ---- auto-return (sweep) records ----
    async getSweep(address) {
      await tick();
      const record = sweeps.get(String(address).toLowerCase());
      return record ? { ...record } : null;
    },
    // Replaces the record unless a NEWER one (larger signedAt) is stored. Returns false when ignored.
    async putSweep(address, record) {
      await tick();
      const key = String(address).toLowerCase();
      const existing = sweeps.get(key);
      if (existing && existing.signedAt > record.signedAt) return false;
      sweeps.set(key, { ...record, address: key });
      return true;
    },
    // Heartbeat: refreshes lastSeen when the record exists for this pid. Returns the status or null.
    async touchSweep(address, pidHash, lastSeen) {
      await tick();
      const record = sweeps.get(String(address).toLowerCase());
      if (!record || record.pidHash !== pidHash) return null;
      record.lastSeen = Math.max(record.lastSeen || 0, lastSeen);
      return record.status;
    },
    async listSweeps() {
      await tick();
      return [...sweeps.values()].map((record) => ({ ...record }));
    },
    // armed (or a stale "sending") -> sending, only for this exact signature.
    async claimSweep(address, signedAt, nowSeconds, sendingBefore, idleBefore) {
      await tick();
      const record = sweeps.get(String(address).toLowerCase());
      if (!record || record.signedAt !== signedAt) return false;
      if (!(record.lastSeen < idleBefore)) return false; // a heartbeat after the scan cancels the broadcast
      if (!(record.status === "armed" || (record.status === "sending" && (record.sendingAt || 0) < sendingBefore))) return false;
      record.status = "sending";
      record.sendingAt = nowSeconds;
      return true;
    },
    // Conditional on signedAt: a re-arm in the meantime wins. null values remove the field.
    async finishSweep(address, signedAt, fields) {
      await tick();
      const record = sweeps.get(String(address).toLowerCase());
      if (!record || record.signedAt !== signedAt) return false;
      for (const [name, value] of Object.entries(fields)) {
        if (value === null || value === undefined) delete record[name];
        else record[name] = value;
      }
      return true;
    },
    async getSweepSettings() {
      await tick();
      return shared.sweepSettings ? { ...shared.sweepSettings } : null;
    },
    async setSweepSettings(idleMinutes, updatedAt) {
      await tick();
      shared.sweepSettings = { idleMinutes, updatedAt };
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
