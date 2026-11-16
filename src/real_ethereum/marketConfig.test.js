import {
  isMarketConfigStorageKey,
  subscribeToMarketChanges,
  MARKET_CHANGED_EVENT,
} from "./marketConfig";

const storage = (key, newValue = "x") =>
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));

const KEY = "data-market:factory-address:sapphire-v1";
const ENV_OLD = "0x1111111111111111111111111111111111111111";
const ENV_NEW = "0x2222222222222222222222222222222222222222";
const OVERRIDE = "0x3333333333333333333333333333333333333333";

// marketConfig reads REACT_APP_FACTORY_ADDRESS at module load, so load a fresh copy per env.
const loadWithEnv = (envAddress) => {
  // A local .env may define any of the fallback variables too: blank them all for a deterministic env.
  const names = [
    "REACT_APP_FACTORY_ADDRESS",
    "REACT_APP_MARKET_FACTORY_ADDRESS",
    "REACT_APP_TEST_FACTORY_ADDRESS",
    "REACT_APP_DEV_FACTORY_ADDRESS",
    "REACT_APP_REAL_FACTORY_ADDRESS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  names.forEach((name) => delete process.env[name]);
  if (envAddress) process.env.REACT_APP_FACTORY_ADDRESS = envAddress;
  let mod;
  jest.isolateModules(() => {
    mod = require("./marketConfig");
  });
  names.forEach((name) => {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  });
  return mod;
};

describe("factory address override vs REACT_APP_FACTORY_ADDRESS", () => {
  beforeEach(() => window.localStorage.clear());

  test("an override set under the current env address still wins and stores {address, envAddressAtSet}", () => {
    const config = loadWithEnv(ENV_OLD);
    config.setMarketFactoryAddress("primary", OVERRIDE);
    expect(JSON.parse(window.localStorage.getItem(KEY))).toEqual({
      address: OVERRIDE,
      envAddressAtSet: ENV_OLD,
    });
    expect(config.getMarketFactoryAddress("primary")).toBe(OVERRIDE);
  });

  test("a new env address wins over a stale override and deletes it", () => {
    loadWithEnv(ENV_OLD).setMarketFactoryAddress("primary", OVERRIDE);
    const redeployed = loadWithEnv(ENV_NEW);
    expect(redeployed.getMarketFactoryAddress("primary")).toBe(ENV_NEW);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("an override set with no env survives while env stays empty, loses once env is set", () => {
    loadWithEnv("").setMarketFactoryAddress("primary", OVERRIDE);
    expect(loadWithEnv("").getMarketFactoryAddress("primary")).toBe(OVERRIDE);
    expect(loadWithEnv(ENV_NEW).getMarketFactoryAddress("primary")).toBe(ENV_NEW);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("a legacy plain-string override is dropped when a different env address is configured", () => {
    window.localStorage.setItem(KEY, OVERRIDE);
    expect(loadWithEnv(ENV_NEW).getMarketFactoryAddress("primary")).toBe(ENV_NEW);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("a legacy plain-string override is kept when no env address is configured", () => {
    window.localStorage.setItem(KEY, OVERRIDE);
    expect(loadWithEnv("").getMarketFactoryAddress("primary")).toBe(OVERRIDE);
  });

  test("a corrupt stored value is ignored", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadWithEnv(ENV_NEW).getMarketFactoryAddress("primary")).toBe(ENV_NEW);
  });
});

describe("subscribeToMarketChanges storage handling", () => {
  let callback;
  let off;
  beforeEach(() => {
    callback = jest.fn();
    off = subscribeToMarketChanges(callback);
  });
  afterEach(() => off());

  test.each([
    "data-market:rpc-health:v1",
    "data-market:auctions:v5:0xabc:20",
    "data-market:active-auctions",
    "some-other-app-key",
  ])("ignores unrelated key %s", (key) => {
    storage(key);
    expect(callback).not.toHaveBeenCalled();
  });

  test.each([
    "data-market:active-factory",
    "data-market:factory-address:sapphire-v1",
    "data-market:market-label",
  ])("reacts to market-config key %s", (key) => {
    expect(isMarketConfigStorageKey(key)).toBe(true);
    storage(key);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("reacts to a cleared storage (null key)", () => {
    storage(null, null);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("in-page market change event still notifies", () => {
    window.dispatchEvent(new CustomEvent(MARKET_CHANGED_EVENT, { detail: { reason: "active-market" } }));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("two tabs repeatedly writing rpc-health never notify", () => {
    for (let i = 0; i < 50; i += 1) {
      storage("data-market:rpc-health:v1", String(i));
      storage("data-market:rpc-health:v1", String(i + 1));
    }
    expect(callback).not.toHaveBeenCalled();
  });

  test("unsubscribe removes the storage listener", () => {
    off();
    storage("data-market:active-factory");
    expect(callback).not.toHaveBeenCalled();
  });
});
