// Tiny bus: "the native balance of the local wallet may have changed". The local wallet emits it after every
// transaction it sends (and again when that transaction is mined); the auto-return code listens and re-signs.
const listeners = new Set();

export const subscribeBalanceEvents = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const emitBalanceEvent = (reason = "unknown") => {
  listeners.forEach((listener) => {
    try { listener(reason); } catch { /* one broken listener must not stop the others */ }
  });
};
