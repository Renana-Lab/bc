"use strict";
// Auto-return ("sweep") of leftover native TEST to the lab wallet.
//
// The browser signs (never broadcasts) a plain transfer of its remaining balance to the sweep address and arms it here.
// A scheduled job broadcasts the stored transaction once the participant has been idle for a while. The faucet never
// holds participant keys: the stored raw transaction can only do the one thing it was signed for (pay the sweep
// address), and it dies on its own as soon as the participant sends anything else (nonce used) or the balance changes.
const { Transaction, getAddress, isAddress } = require("ethers");

const MIN_SWEEP_GAS = 21000n;
const MAX_SWEEP_GAS = 100000n;
const MIN_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 1440;
const DEFAULT_IDLE_MINUTES = 30;
const MAX_JOB_ENTRIES = 50;
const SENDING_RETRY_SECONDS = 600; // a crashed run left "sending": retry after this long
const SENT_GIVE_UP_SECONDS = 1800; // broadcast but never mined
const MAX_ATTEMPTS = 3;
const PID_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RAW_TX_PATTERN = /^0x[0-9a-fA-F]{2,2000}$/;

// Checks everything the server relies on: the transaction decodes, is signed by `address`, pays exactly the sweep
// address with no data, targets the configured chain and uses a sane gas limit. Returns { ok, reason?, tx? }.
const validateSweepTx = ({ rawTx, address, sweepAddress, chainId }) => {
  let tx;
  try { tx = Transaction.from(rawTx); } catch { return { ok: false, reason: "decode" }; }
  if (!tx.signature || tx.type !== 0) return { ok: false, reason: "decode" };
  if (tx.chainId !== BigInt(chainId)) return { ok: false, reason: "chain" };
  if (!tx.from || tx.from.toLowerCase() !== String(address).toLowerCase()) return { ok: false, reason: "signer" };
  if (!tx.to || !sweepAddress || tx.to.toLowerCase() !== String(sweepAddress).toLowerCase()) return { ok: false, reason: "recipient" };
  if (tx.data !== "0x") return { ok: false, reason: "data" };
  if (!(tx.value > 0n)) return { ok: false, reason: "value" };
  if (!(tx.gasLimit >= MIN_SWEEP_GAS && tx.gasLimit <= MAX_SWEEP_GAS) || !(tx.gasPrice > 0n)) return { ok: false, reason: "gas" };
  return { ok: true, tx, maxCost: tx.value + tx.gasPrice * tx.gasLimit };
};

const parseIdleMinutes = (value) => (Number.isInteger(value) && value >= MIN_IDLE_MINUTES && value <= MAX_IDLE_MINUTES ? value : null);

const publicSweep = (entry) => ({
  address: entry.address,
  pidHash: entry.pidHash,
  lastSeen: entry.lastSeen ? new Date(entry.lastSeen * 1000).toISOString() : null,
  armedValue: entry.status === "armed" || entry.status === "stale" ? entry.value || "0" : "0",
  status: entry.status || "none",
  txHash: entry.txHash || null,
  returnedWei: entry.returnedWei || "0",
});

const NONCE_USED = /nonce too low|nonce has already been used/i;
const ALREADY_KNOWN = /already known|known transaction|already imported/i;
const NO_FUNDS = /insufficient funds|insufficient balance/i;

// One scheduler tick. Returns counts so the caller can log them.
const runSweepJob = async ({ store, chain, config, now = () => Date.now(), log = () => {} }) => {
  const settings = await store.getSweepSettings().catch(() => null);
  const idleMinutes = parseIdleMinutes(settings?.idleMinutes) ?? parseIdleMinutes(config.sweepIdleMinutes) ?? DEFAULT_IDLE_MINUTES;
  const nowSec = Math.floor(now() / 1000);
  const idleBefore = nowSec - idleMinutes * 60;
  const result = { sent: 0, stale: 0, confirmed: 0, retry: 0, skipped: 0 };
  const entries = (await store.listSweeps()).slice(0, 1000);
  let processed = 0;

  const finish = (entry, fields) => store.finishSweep(entry.address, entry.signedAt, fields);
  const markStale = async (entry, reason) => {
    await finish(entry, { status: "stale", error: reason, rawTx: null });
    result.stale += 1;
    log({ event: "sweep_stale", address: entry.address.slice(0, 8), reason });
  };

  for (const entry of entries) {
    try {
      // Reconcile transactions broadcast by an earlier run.
      if (entry.status === "sent" && !entry.confirmedAt) {
        const receipt = await chain.getReceipt(entry.txHash);
        if (receipt) {
          if (receipt.status === 1) {
            const returned = BigInt(entry.returnedWei || "0") + BigInt(entry.value || "0");
            await finish(entry, { confirmedAt: nowSec, returnedWei: returned.toString() });
            result.confirmed += 1;
          } else {
            await markStale(entry, "reverted");
          }
        } else if (nowSec - (entry.sentAt || 0) > SENT_GIVE_UP_SECONDS) {
          await markStale(entry, "not_mined");
        }
        continue;
      }
      const retrySending = entry.status === "sending" && (entry.sendingAt || 0) < nowSec - SENDING_RETRY_SECONDS;
      if (!(entry.status === "armed" || retrySending) || !(entry.lastSeen < idleBefore)) continue;
      if (processed >= MAX_JOB_ENTRIES) { result.skipped += 1; continue; }
      processed += 1;

      if (!entry.rawTx) { await markStale(entry, "missing"); continue; }
      const checked = validateSweepTx({ rawTx: entry.rawTx, address: entry.address, sweepAddress: config.sweepAddress, chainId: config.chainId });
      if (!checked.ok && !(checked.reason === "recipient" && !config.sweepAddress)) { await markStale(entry, checked.reason); continue; }
      const tx = Transaction.from(entry.rawTx);
      // Cheap pre-checks: a used nonce or a changed balance means the participant was active after all.
      const [nonce, balance] = await Promise.all([chain.getNonce(entry.address), chain.getBalance(entry.address)]);
      if (BigInt(nonce) !== BigInt(tx.nonce)) { await markStale(entry, "nonce"); continue; }
      if (balance < tx.value + tx.gasPrice * tx.gasLimit) { await markStale(entry, "balance"); continue; }

      // Claim the entry (armed -> sending, conditional): a parallel run or a re-arm wins over us cleanly.
      if (!(await store.claimSweep(entry.address, entry.signedAt, nowSec, nowSec - SENDING_RETRY_SECONDS))) continue;
      try {
        await chain.sendRaw(entry.rawTx);
        await finish(entry, { status: "sent", txHash: tx.hash, sentAt: nowSec, error: null });
        result.sent += 1;
        log({ event: "sweep_sent", address: entry.address.slice(0, 8) });
      } catch (error) {
        const message = String(error?.message || "");
        if (ALREADY_KNOWN.test(message)) {
          await finish(entry, { status: "sent", txHash: tx.hash, sentAt: nowSec, error: null });
          result.sent += 1;
        } else if (NONCE_USED.test(message)) {
          const known = (await chain.getTransaction(tx.hash)) || (await chain.getReceipt(tx.hash));
          if (known) { await finish(entry, { status: "sent", txHash: tx.hash, sentAt: nowSec, error: null }); result.sent += 1; }
          else await markStale(entry, "nonce");
        } else if (NO_FUNDS.test(message)) {
          await markStale(entry, "balance");
        } else {
          const attempts = (entry.attempts || 0) + 1;
          if (attempts >= MAX_ATTEMPTS) await markStale(entry, "broadcast");
          else { await finish(entry, { status: "armed", attempts, error: "broadcast" }); result.retry += 1; }
        }
      }
    } catch (error) {
      log({ event: "sweep_error", address: String(entry.address).slice(0, 8), message: String(error?.message || "").slice(0, 100) });
    }
  }
  return result;
};

module.exports = {
  validateSweepTx, runSweepJob, parseIdleMinutes, publicSweep,
  MIN_IDLE_MINUTES, MAX_IDLE_MINUTES, DEFAULT_IDLE_MINUTES, PID_HASH_PATTERN, RAW_TX_PATTERN, isAddress, getAddress,
};
