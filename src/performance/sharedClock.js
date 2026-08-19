import { useSyncExternalStore } from "react";

const subscribers = new Set();
let now = Date.now();
let timer = null;
let visibilityBound = false;

const emit = () => {
  now = Date.now();
  subscribers.forEach((subscriber) => subscriber());
};

const stopTimer = () => {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
};

const startTimer = () => {
  if (typeof window === "undefined" || timer !== null || !subscribers.size) return;
  if (document.hidden) return;
  timer = window.setInterval(emit, 1000);
};

const handleVisibilityChange = () => {
  if (document.hidden) {
    stopTimer();
    return;
  }
  emit();
  startTimer();
};

const bindVisibility = () => {
  if (visibilityBound || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  visibilityBound = true;
};

export const subscribeSharedClock = (subscriber) => {
  subscribers.add(subscriber);
  bindVisibility();
  startTimer();

  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) stopTimer();
  };
};

export const getSharedClockSnapshot = () => now;

export const useSharedClock = () =>
  useSyncExternalStore(
    subscribeSharedClock,
    getSharedClockSnapshot,
    getSharedClockSnapshot,
  );

export const getSharedClockDiagnostics = () => ({
  subscribers: subscribers.size,
  running: timer !== null,
  now,
});

