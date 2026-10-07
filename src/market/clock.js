import { useSyncExternalStore } from 'react';
let offset = 0,
  now = Date.now(),
  timer;
const listeners = new Set();
const tick = () => {
  now = Date.now() + offset;
  for (const listener of listeners) listener();
};
const visibility = () => {
  clearInterval(timer);
  if (!document.hidden) {
    tick();
    timer = setInterval(tick, 1000);
  }
};
const subscribe = listener => {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', visibility);
    visibility();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    }
  };
};
export const synchronizeMarketClock = timestamp => {
  if (Number.isFinite(timestamp)) {
    offset = timestamp - Date.now();
    tick();
  }
};
export const useMarketNow = () => useSyncExternalStore(subscribe, () => now, () => now);
