// Holds the raw EIP-1193 provider of the active embedded wallet mode (local).
// It is RAW on purpose: every consumer reaches it through getSapphireProvider(), which adds the
// calldata guard and the Sapphire encryption wrapper. Nothing should call it directly.
let current = null;
const listeners = new Set();

export const getModeProvider = () => current;
export const subscribeModeProvider = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// `isUnlocked` tells walletAccess whether the user has a usable session (logged in / unlocked).
export const setModeProvider = (raw, isUnlocked) => {
  if (raw === current?.__raw) return;
  current = raw
    ? {
        __raw: raw,
        request: (args) => raw.request(args),
        on: (event, listener) => raw.on?.(event, listener),
        removeListener: (event, listener) => raw.removeListener?.(event, listener),
        isUnlocked: isUnlocked || (async () => (await raw.request({ method: "eth_accounts" })).length > 0),
      }
    : null;
  listeners.forEach((listener) => listener());
};
