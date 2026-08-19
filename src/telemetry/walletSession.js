let account = "";
const subscribers = new Set();

export const getWalletSessionAccount = () => account;

export const setWalletSessionAccount = (nextAccount) => {
  const normalized = String(nextAccount || "").toLowerCase();
  if (normalized === account) return;
  account = normalized;
  subscribers.forEach((subscriber) => subscriber(account));
};

export const subscribeToWalletSession = (subscriber) => {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
};
