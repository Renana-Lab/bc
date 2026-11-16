import { useEffect, useState } from "react";
import { readOnlyExecute } from "./readOnly";

// Auction deadlines are enforced against block.timestamp, so timers use chain time:
// chainNowMs() = Date.now() + offset, offset = latestBlock.timestamp*1000 - localNowAtFetch.
export const SYNC_INTERVAL_MS = 30000;
// Block timestamps lag real time by up to one round; keep a margin before the deadline.
export const BID_SAFETY_MARGIN_MS = 2000;

let offsetMs = 0;
let synced = false;
let lastSyncAt = 0;
let inFlight = null;
const listeners = new Set();
let timerId = null;
let focusBound = false;

const notify = () => {
  listeners.forEach((listener) => {
    try {
      listener(chainNowMs());
    } catch (_error) {
      // listeners must never break the clock
    }
  });
};

export const chainNowMs = () => Date.now() + offsetMs;
export const getChainClockOffsetMs = () => offsetMs;
export const isChainClockSynced = () => synced;

export const syncChainClock = ({ force = false } = {}) => {
  if (inFlight) return inFlight;
  if (!force && synced && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) {
    return Promise.resolve(offsetMs);
  }
  const startedAt = Date.now();
  inFlight = Promise.resolve()
    .then(() => readOnlyExecute(({ web3 }) => web3.eth.getBlock("latest")))
    .then((block) => {
      const seconds = Number(block?.timestamp);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("bad block timestamp");
      // Use the midpoint of the request so latency does not skew the offset.
      const localAtFetch = Math.round((startedAt + Date.now()) / 2);
      offsetMs = seconds * 1000 - localAtFetch;
      synced = true;
      lastSyncAt = Date.now();
      notify();
      return offsetMs;
    })
    .catch(() => offsetMs) // keep the last offset, never throw into render
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

const onFocus = () => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  syncChainClock();
};

const start = () => {
  syncChainClock();
  if (!timerId) timerId = setInterval(() => syncChainClock({ force: true }), SYNC_INTERVAL_MS);
  if (!focusBound && typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    focusBound = true;
  }
};

const stop = () => {
  if (timerId) clearInterval(timerId);
  timerId = null;
  if (focusBound && typeof window !== "undefined") window.removeEventListener("focus", onFocus);
  focusBound = false;
};

export const subscribeChainClock = (listener) => {
  listeners.add(listener);
  if (listeners.size === 1) start();
  else syncChainClock();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stop();
  };
};

export const __resetChainClockForTests = () => {
  stop();
  listeners.clear();
  offsetMs = 0;
  synced = false;
  lastSyncAt = 0;
  inFlight = null;
};

// Subscribes the component to the shared clock (starts syncing) and re-renders it
// whenever the offset is refreshed. Returns a counter usable as an effect dependency.
export const useChainClockSync = () => {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeChainClock(() => setTick((n) => n + 1)), []);
  return tick;
};
