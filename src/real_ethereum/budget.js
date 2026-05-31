import { readOnlyCall } from "./readOnly";
import { getActiveFactoryAddress, subscribeToMarketChanges } from "./marketConfig";
import { getEthereumAccounts, getEthereumProvider } from "./ethereumProvider";

const CACHE_TTL_MS = 15000;
export const BUDGET_CHANGED_EVENT = "data-market:budget-changed";
const budgetCache = new Map();
const budgetInFlight = new Map();
const normalizeFactoryAddress = (address) =>
  String(address || "").trim().toLowerCase();
const normalizeUserAddress = (address) =>
  String(address || "").trim().toLowerCase();
const getBudgetKey = (factoryAddress, userAddress) =>
  `${normalizeFactoryAddress(factoryAddress)}:${normalizeUserAddress(userAddress)}`;

subscribeToMarketChanges(() => {
  budgetCache.clear();
  budgetInFlight.clear();
});

export const setCachedBudget = (userAddress, factoryAddress, value) => {
  if (!userAddress || value === undefined || value === null) return;
  budgetCache.set(getBudgetKey(factoryAddress, userAddress), {
    value: String(value),
    updatedAt: Date.now(),
  });
};

export const invalidateBudgetCache = (userAddress, factoryAddress) => {
  if (!userAddress && !factoryAddress) {
    budgetCache.clear();
    budgetInFlight.clear();
    return;
  }

  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);
  const normalizedUserAddress = normalizeUserAddress(userAddress);

  Array.from(budgetCache.keys()).forEach((key) => {
    const [factoryKey, userKey] = key.split(":");
    const matchesFactory =
      !normalizedFactoryAddress || factoryKey === normalizedFactoryAddress;
    const matchesUser = !normalizedUserAddress || userKey === normalizedUserAddress;

    if (matchesFactory && matchesUser) budgetCache.delete(key);
  });

  Array.from(budgetInFlight.keys()).forEach((key) => {
    const [factoryKey, userKey] = key.split(":");
    const matchesFactory =
      !normalizedFactoryAddress || factoryKey === normalizedFactoryAddress;
    const matchesUser = !normalizedUserAddress || userKey === normalizedUserAddress;

    if (matchesFactory && matchesUser) budgetInFlight.delete(key);
  });
};

export const notifyBudgetChanged = ({ userAddress, factoryAddress, budget } = {}) => {
  if (budget !== undefined && budget !== null) {
    setCachedBudget(userAddress, factoryAddress, budget);
  } else {
    invalidateBudgetCache(userAddress, factoryAddress);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(BUDGET_CHANGED_EVENT, {
        detail: {
          userAddress: normalizeUserAddress(userAddress),
          factoryAddress: normalizeFactoryAddress(factoryAddress),
          budget: budget === undefined || budget === null ? null : String(budget),
        },
      })
    );
  }
};

export const subscribeToBudgetChanges = (callback) => {
  if (typeof window === "undefined") return () => {};

  const handler = (event) => callback(event.detail || {});
  window.addEventListener(BUDGET_CHANGED_EVENT, handler);

  return () => window.removeEventListener(BUDGET_CHANGED_EVENT, handler);
};

export const getDefaultBudget = async ({ force = false } = {}) => {
  if (!getEthereumProvider()) return undefined;

  const factoryAddress = getActiveFactoryAddress();
  const accounts = await getEthereumAccounts();
  const userAddress = accounts[0] || "";

  if (!userAddress) return undefined;

  const key = getBudgetKey(factoryAddress, userAddress);
  const cached = budgetCache.get(key);

  if (!force && cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  if (!force && budgetInFlight.has(key)) {
    return budgetInFlight.get(key);
  }

  const request = readOnlyCall(
    ({ factory }) => factory.methods.getBudget(userAddress),
    undefined,
    { factoryAddress }
  )
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
