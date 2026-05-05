import { readOnlyCall } from "./readOnly";

const CACHE_TTL_MS = 15000;
const budgetCache = new Map();
const budgetInFlight = new Map();

export const getDefaultBudget = async () => {
  if (!window.ethereum) return undefined;

  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  const userAddress = accounts[0] || "";

  if (!userAddress) return undefined;

  const key = userAddress.toLowerCase();
  const cached = budgetCache.get(key);

  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  if (budgetInFlight.has(key)) {
    return budgetInFlight.get(key);
  }

  const request = readOnlyCall(({ factory }) => factory.methods.getBudget(userAddress))
    .then((value) => {
      budgetCache.set(key, { value, updatedAt: Date.now() });
      return value;
    })
    .finally(() => {
      budgetInFlight.delete(key);
    });

  budgetInFlight.set(key, request);
  return request;
};
