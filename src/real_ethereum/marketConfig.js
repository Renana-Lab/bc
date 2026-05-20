const DEFAULT_FACTORY_ADDRESS = "0xb61Cd17D498f82E9F22771254C31bCBBb5781540";
const MARKET_STORAGE_KEY = "data-market:active-factory";
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

export const getDevelopmentFactoryAddress = () => {
  const configuredAddress =
    process.env.REACT_APP_DEV_FACTORY_ADDRESS ||
    process.env.REACT_APP_TEST_FACTORY_ADDRESS ||
    getStoredValue(DEV_FACTORY_STORAGE_KEY);

  return isValidAddress(configuredAddress) ? normalizeAddress(configuredAddress) : "";
};

export const setDevelopmentFactoryAddress = (address) => {
  const normalizedAddress = normalizeAddress(address);
  if (!isValidAddress(normalizedAddress)) {
    throw new Error("Invalid factory address");
  }

  setStoredValue(DEV_FACTORY_STORAGE_KEY, normalizedAddress);
  return normalizedAddress;
};

export const getMarketOptions = () => [
  {
    id: "real",
    label: "Real",
    description: "Production market",
    address: process.env.REACT_APP_REAL_FACTORY_ADDRESS || DEFAULT_FACTORY_ADDRESS,
  },
  {
    id: "dev",
    label: "Development",
    description: "Testing market",
    address: getDevelopmentFactoryAddress(),
  },
];

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
