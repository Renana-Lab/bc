const DEFAULT_FACTORY_ADDRESS = "0xb61Cd17D498f82E9F22771254C31bCBBb5781540";
const MARKET_STORAGE_KEY = "data-market:active-factory";
const REAL_FACTORY_STORAGE_KEY = "data-market:real-factory-address";
const DEV_FACTORY_STORAGE_KEY = "data-market:dev-factory-address";
export const MARKET_CHANGED_EVENT = "data-market:factory-changed";

const normalizeAddress = (address) => String(address || "").trim();

export const isValidAddress = (address) =>
  /^0x[a-fA-F0-9]{40}$/.test(normalizeAddress(address));

const getStoredValue = (key) => {
  if (typeof window === "undefined" || !window.localStorage) return "";
  return window.localStorage.getItem(key) || "";
};

const setStoredValue = (key, value) => {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem(key, value);
};

const removeStoredValue = (key) => {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.removeItem(key);
};

export const MARKET_DEFINITIONS = [
  {
    id: "real",
    label: "Real",
    description: "Production market",
    storageKey: REAL_FACTORY_STORAGE_KEY,
    envAddress: process.env.REACT_APP_REAL_FACTORY_ADDRESS,
    fallbackAddress: DEFAULT_FACTORY_ADDRESS,
  },
  {
    id: "dev",
    label: "Dev",
    description: "Testing market",
    storageKey: DEV_FACTORY_STORAGE_KEY,
    envAddress:
      process.env.REACT_APP_DEV_FACTORY_ADDRESS ||
      process.env.REACT_APP_TEST_FACTORY_ADDRESS,
    fallbackAddress: "",
  },
];

export const getMarketFactoryAddress = (marketId) => {
  const definition = MARKET_DEFINITIONS.find((market) => market.id === marketId);
  if (!definition) return "";

  const configuredAddress =
    getStoredValue(definition.storageKey) ||
    definition.envAddress ||
    definition.fallbackAddress;

  return isValidAddress(configuredAddress) ? normalizeAddress(configuredAddress) : "";
};

export const getDevelopmentFactoryAddress = () => {
  return getMarketFactoryAddress("dev");
};

export const setMarketFactoryAddress = (marketId, address) => {
  const market = MARKET_DEFINITIONS.find((option) => option.id === marketId);
  if (!market) {
    throw new Error("Unknown market");
  }

  const normalizedAddress = normalizeAddress(address);
  if (!isValidAddress(normalizedAddress)) {
    throw new Error("Invalid factory address");
  }

  setStoredValue(market.storageKey, normalizedAddress);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(MARKET_CHANGED_EVENT, {
        detail: getActiveMarket(),
      })
    );
  }

  return normalizedAddress;
};

export const clearMarketFactoryAddress = (marketId) => {
  const market = MARKET_DEFINITIONS.find((option) => option.id === marketId);
  if (!market) {
    throw new Error("Unknown market");
  }

  removeStoredValue(market.storageKey);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(MARKET_CHANGED_EVENT, {
        detail: getActiveMarket(),
      })
    );
  }
};

export const setDevelopmentFactoryAddress = (address) =>
  setMarketFactoryAddress("dev", address);

export const getMarketOptions = () =>
  MARKET_DEFINITIONS.map(({ id, label, description }) => ({
    id,
    label,
    description,
    address: getMarketFactoryAddress(id),
  }));

export const getActiveMarket = () => {
  const options = getMarketOptions();
  const stored = getStoredValue(MARKET_STORAGE_KEY);
  const active =
    options.find((option) => option.id === stored && option.address) || options[0];

  return active;
};

export const getActiveFactoryAddress = () => getActiveMarket().address;

export const setActiveMarket = (marketId) => {
  const market = getMarketOptions().find((option) => option.id === marketId);
  if (!market?.address) {
    throw new Error("This market does not have a factory address yet");
  }

  setStoredValue(MARKET_STORAGE_KEY, market.id);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(MARKET_CHANGED_EVENT, {
        detail: market,
      })
    );
  }

  return market;
};

export const subscribeToMarketChanges = (callback) => {
  if (typeof window === "undefined") return () => {};

  const handler = (event) => callback(event.detail || getActiveMarket());
  window.addEventListener(MARKET_CHANGED_EVENT, handler);
  window.addEventListener("storage", handler);

  return () => {
    window.removeEventListener(MARKET_CHANGED_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
};

export default DEFAULT_FACTORY_ADDRESS;
