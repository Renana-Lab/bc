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
export const computeSweepValue = ({ balance, gasPrice }) => BigInt(balance) - sweepFee(gasPrice);

const MAX_WAIT_MS = 30_000; // a constant stream of events still produces a signature at least this often

export const createSweepController = ({
  address, sweepAddress, chainId, pidHash,
  readBalance, readNonce, readGasPrice, signTransfer, post, beacon = () => false,
  debounceMs = 5000, heartbeatMs = 300_000, pollMs = 20_000, retryMs = 10_000,
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
  const timers = [];

  const send = async (payload) => {
    const result = await post("/sweep/arm", payload);
    return result;
  };

  const resign = async ({ force = false } = {}) => {
    if (disposed) return;
    let balance; let nonce; let gasPrice;
    try { [balance, nonce, gasPrice] = await Promise.all([readBalance(), readNonce(), readGasPrice()]); } catch { return; }
    balance = BigInt(balance);
    nonce = Number(nonce);
    const value = computeSweepValue({ balance, gasPrice });
    let payload;
    if (value <= 0n) {
      if (lastKind === "cancel" && !force) { lastBalance = balance; return; }
      payload = { pidHash, address, cancel: true, signedAt: now() };
    } else {
      if (!force && lastKind === "armed" && lastBalance === balance && lastNonce === nonce) return;
      try {
        const rawTx = await signTransfer({ type: 0, chainId, to: sweepAddress, value, nonce, gasPrice: BigInt(gasPrice), gasLimit: SWEEP_GAS_LIMIT });
        payload = { pidHash, address, rawTx, signedAt: now() };
      } catch { return; }
    }
    const result = await send(payload);
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
    const result = await post("/sweep/heartbeat", { pidHash, address });
    if (result.status !== 200) return;
    const status = result.body?.status;
    // The server dropped or used our transaction (the participant was active in between): sign a fresh one.
    if (status === "stale" || status === "sent" || (status === "none" && lastKind === "armed")) enqueue({ force: true });
  };

  const onPageHide = () => {
    if (lastPayload) beacon("/sweep/arm", { ...lastPayload, signedAt: now() });
  };
  const onVisible = () => { if (doc && !doc.hidden) { heartbeat(); checkBalance(); } };

  const unsubscribe = subscribe(() => poke("balance-event"));
  timers.push(setInterval(heartbeat, heartbeatMs));
  timers.push(setInterval(checkBalance, pollMs));
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
