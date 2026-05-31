const NEW_BUDGET_LEDGER_FACTORY_ADDRESS = "0xec38565FAeeef009F57037F2804D186928E63629";
const DEFAULT_FACTORY_ADDRESS = NEW_BUDGET_LEDGER_FACTORY_ADDRESS;
const DEFAULT_DEV_FACTORY_ADDRESS = NEW_BUDGET_LEDGER_FACTORY_ADDRESS;
const MARKET_STORAGE_KEY = "data-market:active-factory";
const ACTIVE_FACTORY_STORAGE_KEY = "data-market:factory-address:v2";
const ACTIVE_LABEL_STORAGE_KEY = "data-market:market-label";
export const MARKET_CHANGED_EVENT = "data-market:factory-changed";

const normalizeAddress = (address) => String(address || "").trim();
const normalizeLabel = (label) => String(label || "").trim();

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

const firstValidAddress = (...addresses) =>
  addresses.map(normalizeAddress).find((address) => isValidAddress(address)) || "";

const normalizeEnvironment = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["test", "testing", "dev", "development", "staging"].includes(normalized)) {
    return "testing";
  }
  return "production";
};

export const MARKET_ENVIRONMENT = normalizeEnvironment(
  process.env.REACT_APP_MARKET_ENV ||
    process.env.REACT_APP_DEPLOY_ENV ||
    process.env.REACT_APP_ENVIRONMENT ||
    process.env.REACT_APP_BRANCH
);

export const MARKET_ENVIRONMENT_LABEL =
  MARKET_ENVIRONMENT === "testing" ? "Testing" : "Production";

const getMarketLabel = (market) =>
  normalizeLabel(getStoredValue(market.labelStorageKey)) || market.label;

const dispatchMarketChanged = (market = getActiveMarket(), reason = "config") => {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent(MARKET_CHANGED_EVENT, {
      detail: {
        market,
        reason,
      },
    })
  );
};

export const MARKET_DEFINITIONS = [
  {
    id: "primary",
    label: MARKET_ENVIRONMENT_LABEL,
    description:
      MARKET_ENVIRONMENT === "testing"
        ? "Testing branch contract"
        : "Production contract",
    storageKey: ACTIVE_FACTORY_STORAGE_KEY,
    labelStorageKey: ACTIVE_LABEL_STORAGE_KEY,
    envAddress:
      process.env.REACT_APP_FACTORY_ADDRESS ||
      process.env.REACT_APP_MARKET_FACTORY_ADDRESS ||
      (MARKET_ENVIRONMENT === "testing"
        ? process.env.REACT_APP_TEST_FACTORY_ADDRESS ||
          process.env.REACT_APP_DEV_FACTORY_ADDRESS
        : process.env.REACT_APP_REAL_FACTORY_ADDRESS),
    fallbackAddress:
      MARKET_ENVIRONMENT === "testing"
        ? DEFAULT_DEV_FACTORY_ADDRESS
        : DEFAULT_FACTORY_ADDRESS,
  },
];

export const getMarketFactoryAddress = (marketId) => {
  const definition = MARKET_DEFINITIONS.find((market) => market.id === marketId);
  if (!definition) return "";

  return firstValidAddress(
    getStoredValue(definition.storageKey),
    definition.envAddress,
    definition.fallbackAddress
  );
};

export const getDevelopmentFactoryAddress = () => {
  return getMarketFactoryAddress("primary");
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
  dispatchMarketChanged(getActiveMarket(), "factory-address");

  return normalizedAddress;
};

export const clearMarketFactoryAddress = (marketId) => {
  const market = MARKET_DEFINITIONS.find((option) => option.id === marketId);
  if (!market) {
    throw new Error("Unknown market");
  }

  removeStoredValue(market.storageKey);
  dispatchMarketChanged(getActiveMarket(), "factory-address");
};

export const setDevelopmentFactoryAddress = (address) =>
  setMarketFactoryAddress("primary", address);

export const setMarketLabel = (marketId, label) => {
  const market = MARKET_DEFINITIONS.find((option) => option.id === marketId);
  if (!market) {
    throw new Error("Unknown market");
  }

  const normalizedLabel = normalizeLabel(label);
  if (!normalizedLabel) {
    throw new Error("Market name cannot be empty");
  }

  if (normalizedLabel.length > 18) {
    throw new Error("Market name must be 18 characters or fewer");
  }

  setStoredValue(market.labelStorageKey, normalizedLabel);
  dispatchMarketChanged(getActiveMarket(), "label");
  return normalizedLabel;
};

export const clearMarketLabel = (marketId) => {
  const market = MARKET_DEFINITIONS.find((option) => option.id === marketId);
  if (!market) {
    throw new Error("Unknown market");
  }

  removeStoredValue(market.labelStorageKey);
  dispatchMarketChanged(getActiveMarket(), "label");
};

export const getMarketOptions = () =>
  MARKET_DEFINITIONS.map((market) => ({
    id: market.id,
    label: getMarketLabel(market),
    defaultLabel: market.label,
    description: market.description,
    environment: MARKET_ENVIRONMENT,
    environmentLabel: MARKET_ENVIRONMENT_LABEL,
    address: getMarketFactoryAddress(market.id),
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
  const market = getMarketOptions().find((option) => option.id === marketId) || getActiveMarket();
  if (!market?.address) {
    throw new Error("This market does not have a factory address yet");
  }

  setStoredValue(MARKET_STORAGE_KEY, market.id);
  dispatchMarketChanged(market, "active-market");

  return market;
};

export const subscribeToMarketChanges = (callback) => {
  if (typeof window === "undefined") return () => {};

  const handler = (event) => {
    const detail = event.detail || {};
    const market = detail.market || (detail.id ? detail : getActiveMarket());
    callback(market, detail);
  };
  window.addEventListener(MARKET_CHANGED_EVENT, handler);
  window.addEventListener("storage", handler);

  return () => {
    window.removeEventListener(MARKET_CHANGED_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
};

export default DEFAULT_FACTORY_ADDRESS;
