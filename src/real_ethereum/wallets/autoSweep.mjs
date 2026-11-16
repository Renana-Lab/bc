import { subscribeBalanceEvents } from "./balanceEvents.mjs";

// Auto-return of leftover native balance. The browser SIGNS (never broadcasts) a plain transfer of its remaining
// balance to the lab address and hands it to the faucet server, which broadcasts it only after the participant has
// been inactive for a while. Everything is silent. Any event that can change the balance re-signs (debounced).
//
// A plain transfer on Sapphire needs more than 21000 gas (measured 22132; 21000 reverts), so the signed gas limit is
// the same 60000 the faucet uses; unused gas is refunded by the chain.
export const SWEEP_GAS_LIMIT = 60000n;
export const sweepFee = (gasPrice) => (SWEEP_GAS_LIMIT * BigInt(gasPrice) * 12n) / 10n; // 20% headroom for a price rise

// Value to send: balance minus the fee reserve. <= 0 means there is nothing worth returning.
// Must match infrastructure/faucet/sweep.js: cancel and heartbeat are signed so a pid alone cannot touch a record.
export const sweepMessage = (action, address, pidHash, ts) => `bc-sweep|${action}|${String(address).toLowerCase()}|${pidHash}|${ts}`;

export const computeSweepValue = ({ balance, gasPrice }) => BigInt(balance) - sweepFee(gasPrice);

const MAX_WAIT_MS = 30_000; // a constant stream of events still produces a signature at least this often

export const createSweepController = ({
  address, sweepAddress, chainId, pidHash,
  readBalance, readNonce, readGasPrice, signTransfer, signMessage, post, beacon = () => false,
  // beforeSign() resolves false while a refund/payment is still waiting to be withdrawn: nothing may be swept then.
  beforeSign = async () => true,
  debounceMs = 5000, heartbeatMs = 120_000, pollMs = 20_000, retryMs = 10_000, resignMs = 600_000,
  isVisible = () => !globalThis.document?.hidden, now = () => Date.now(),
  win = globalThis.window, doc = globalThis.document, subscribe = subscribeBalanceEvents,
}) => {
  let disposed = false;
  let lastKind = null; // "armed" | "cancel" | null (nothing sent yet in this page load)
  let lastBalance = null;
  let lastNonce = null;
  let lastPayload = null;
  let debounceTimer = null;
  let firstPokeAt = 0;
  let running = Promise.resolve();
  let retried = false;
  let unsafeCancel = false; // a cancel is wanted because a withdrawal is still pending
  let cancelPending = false; // the last cancel was not delivered (server refused or unreachable): try again
  const timers = [];

  const send = async (payload) => {
    const result = await post("/sweep/arm", payload);
    return result;
  };

  const cancelPayload = async () => {
    const ts = now();
    return { pidHash, address, cancel: true, signedAt: ts, sig: await signMessage(sweepMessage("cancel", address, pidHash, ts)) };
  };

  // periodic: only refreshes an armed transfer (a gas price change must not leave a stale one); never creates one.
  const resign = async ({ force = false, periodic = false } = {}) => {
    if (disposed) return;
    // The 10-minute timer (and a return to the tab) refreshes an armed transfer and also retries a sweep that was
    // held back because a withdrawal failed; it never creates a transfer out of nothing.
    if (periodic && lastKind !== "armed" && !unsafeCancel && !cancelPending) return;
    if (periodic) force = true;
    let safe = true;
    try { safe = (await beforeSign()) !== false; } catch { safe = false; }
    if (disposed) return;
    if (periodic && unsafeCancel && !safe && !cancelPending) return; // still blocked and the cancel is in place
    let balance; let nonce; let gasPrice;
    try { [balance, nonce, gasPrice] = await Promise.all([readBalance(), readNonce(), readGasPrice()]); } catch { return; }
    balance = BigInt(balance);
    nonce = Number(nonce);
    const value = computeSweepValue({ balance, gasPrice });
    let payload;
    if (value <= 0n || !safe) {
      if (lastKind === "cancel" && (!force || periodic)) { lastBalance = balance; if (safe) unsafeCancel = false; return; }
      try { payload = await cancelPayload(); } catch { return; }
    } else {
      if (!force && lastKind === "armed" && lastBalance === balance && lastNonce === nonce) return;
      try {
        const rawTx = await signTransfer({ type: 0, chainId, to: sweepAddress, value, nonce, gasPrice: BigInt(gasPrice), gasLimit: SWEEP_GAS_LIMIT });
        payload = { pidHash, address, rawTx, signedAt: now() };
      } catch { return; }
    }
    const result = await send(payload);
    if (payload.cancel) {
      // Stay in the unsafe state until the cancel has really been delivered (a 403 or an outage is retried by the timer).
      unsafeCancel = !safe;
      cancelPending = result.status !== 200;
    } else if (result.status === 200) {
      unsafeCancel = false;
      cancelPending = false;
    }
    if (result.status === 200) {
      lastKind = payload.cancel ? "cancel" : "armed";
      lastBalance = balance;
      lastNonce = nonce;
      lastPayload = payload;
      retried = false;
    } else if ((result.status === 409 || result.status === 0 || result.status >= 500) && !retried && !disposed) {
      // Nonce raced with a transaction of ours, or the server was unreachable: one more try shortly.
      retried = true;
      timers.push(setTimeout(() => poke("retry"), retryMs));
    }
  };

  // Serialized: two signatures can never be in flight at once.
  const enqueue = (options) => {
    running = running.then(() => resign(options)).catch(() => {});
    return running;
  };

  const poke = (reason = "event") => {
    if (disposed) return;
    const at = now();
    if (!debounceTimer) firstPokeAt = at;
    clearTimeout(debounceTimer);
    const wait = Math.max(0, Math.min(debounceMs, firstPokeAt + MAX_WAIT_MS - at));
    debounceTimer = setTimeout(() => { debounceTimer = null; enqueue(); }, wait);
    return reason;
  };

  // Cheap check used by the poll and by list refreshes: only a changed balance causes a new signature.
  const checkBalance = async () => {
    if (disposed || !isVisible()) return;
    try {
      const balance = BigInt(await readBalance());
      if (lastBalance === null || balance !== lastBalance) poke("balance-change");
    } catch { /* silent */ }
  };

  const heartbeat = async () => {
    if (disposed || !isVisible()) return;
    let payload;
    try {
      const ts = now();
      payload = { pidHash, address, ts, sig: await signMessage(sweepMessage("heartbeat", address, pidHash, ts)) };
    } catch { return; }
    const result = await post("/sweep/heartbeat", payload);
    if (result.status !== 200) return;
    const status = result.body?.status;
    // The server dropped or used our transaction (the participant was active in between): sign a fresh one.
    if (status === "stale" || status === "sent" || (status === "none" && lastKind === "armed")) enqueue({ force: true });
  };

  const onPageHide = () => {
    if (lastPayload) beacon("/sweep/arm", lastPayload.cancel ? lastPayload : { ...lastPayload, signedAt: now() });
  };
  const onVisible = () => { if (doc && !doc.hidden) { heartbeat(); checkBalance(); if (unsafeCancel) enqueue({ periodic: true }); } };

  const unsubscribe = subscribe(() => poke("balance-event"));
  timers.push(setInterval(heartbeat, heartbeatMs));
  timers.push(setInterval(checkBalance, pollMs));
  timers.push(setInterval(() => { if (isVisible()) enqueue({ periodic: true }); }, resignMs));
  win?.addEventListener?.("pagehide", onPageHide);
  doc?.addEventListener?.("visibilitychange", onVisible);
  poke("load");

  return {
    poke, checkBalance, heartbeat, flush: () => { clearTimeout(debounceTimer); debounceTimer = null; return enqueue(); },
    idle: () => running,
    dispose() {
      disposed = true;
      clearTimeout(debounceTimer);
      timers.forEach((timer) => { clearTimeout(timer); clearInterval(timer); });
      unsubscribe();
      win?.removeEventListener?.("pagehide", onPageHide);
      doc?.removeEventListener?.("visibilitychange", onVisible);
    },
  };
};
