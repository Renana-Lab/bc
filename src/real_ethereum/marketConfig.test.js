import {
  isMarketConfigStorageKey,
  subscribeToMarketChanges,
  MARKET_CHANGED_EVENT,
} from "./marketConfig";

const storage = (key, newValue = "x") =>
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));

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
