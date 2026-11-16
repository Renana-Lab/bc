// No factory is committed: the previous Sepolia factory has an incompatible ABI and
// is not confidential. Configure REACT_APP_FACTORY_ADDRESS after a Sapphire deploy.
const DEFAULT_FACTORY_ADDRESS = "";
const DEFAULT_DEV_FACTORY_ADDRESS = "";
const MARKET_STORAGE_KEY = "data-market:active-factory";
const ACTIVE_FACTORY_STORAGE_KEY = "data-market:factory-address:sapphire-v1";
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
  MARKET_ENVIRONMENT === "testing" ? "Development" : "Production";

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
        ? "Development branch contract"
        : "Live production contract",
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

const sameAddress = (a, b) => normalizeAddress(a).toLowerCase() === normalizeAddress(b).toLowerCase();

// The admin-entered override is stored as {address, envAddressAtSet}. It only wins while the
// build-time REACT_APP_FACTORY_ADDRESS is still the one that was current when it was set; once a
// new factory is configured in the environment the stale override is ignored and deleted.
// Legacy plain-string values are kept only when no (different) env address is configured.
const readStoredOverride = (definition) => {
  const raw = getStoredValue(definition.storageKey);
  if (!raw) return "";

  const envAddress = firstValidAddress(definition.envAddress);
  let address = "";
  let envAtSet = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      address = normalizeAddress(parsed.address);
      envAtSet = normalizeAddress(parsed.envAddressAtSet);
    }
  } catch {
    address = normalizeAddress(raw); // legacy format
  }

  const stale =
    !isValidAddress(address) ||
    (envAtSet === null
      ? Boolean(envAddress) && !sameAddress(envAddress, address)
      : !sameAddress(envAtSet, envAddress));
  if (stale) {
    try {
      removeStoredValue(definition.storageKey);
    } catch {
      // storage unavailable: still ignore the value
    }
    return "";
  }
  return address;
};

export const getMarketFactoryAddress = (marketId) => {
  const definition = MARKET_DEFINITIONS.find((market) => market.id === marketId);
  if (!definition) return "";

  return firstValidAddress(
    readStoredOverride(definition),
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

  setStoredValue(
    market.storageKey,
    JSON.stringify({
      address: normalizedAddress,
      envAddressAtSet: firstValidAddress(market.envAddress),
    })
  );
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

export const isMarketConfigStorageKey = (key) =>
  key === MARKET_STORAGE_KEY ||
  key === ACTIVE_FACTORY_STORAGE_KEY ||
  key === ACTIVE_LABEL_STORAGE_KEY ||
  MARKET_DEFINITIONS.some(
    (market) => key === market.storageKey || key === market.labelStorageKey
  );

export const subscribeToMarketChanges = (callback) => {
  if (typeof window === "undefined") return () => {};

  const handler = (event) => {
    const detail = event.detail || {};
    const market = detail.market || (detail.id ? detail : getActiveMarket());
    callback(market, detail);
  };
  const storageHandler = (event) => {
    // event.key is null when storage is cleared; treat that as a change.
    if (event && event.key != null && !isMarketConfigStorageKey(event.key)) return;
    handler(event);
  };
  window.addEventListener(MARKET_CHANGED_EVENT, handler);
  window.addEventListener("storage", storageHandler);

  return () => {
    window.removeEventListener(MARKET_CHANGED_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
};

export default DEFAULT_FACTORY_ADDRESS;
