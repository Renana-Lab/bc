import { getWalletAccess, subscribeWalletAccess, startWalletAccess, verifyWalletAccess } from "./walletAccess";
import { setModeProvider } from "./wallets/modeProvider";
import { getWalletSessionAccount } from "../telemetry/walletSession";

// Local (embedded wallet) mode: background re-checks must be silent, like MetaMask mode.
jest.mock("./sapphireNetworks", () => ({ ensureTargetChain: async () => ({}) }));
jest.mock("./sapphireProvider", () => ({ getSapphireProvider: (provider) => provider }));

const address = "0x1234567890abcdef1234567890abcdef12345678";
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };
let stop;
let raw;
let unlocked;
const originalMode = process.env.REACT_APP_WALLET_MODE;

beforeEach(() => {
  process.env.REACT_APP_WALLET_MODE = "local";
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  unlocked = jest.fn().mockResolvedValue(true);
  raw = { request: jest.fn().mockResolvedValue([address]), on: jest.fn(), removeListener: jest.fn() };
  setModeProvider(raw, unlocked);
});
afterEach(() => {
  stop?.(); stop = null; setModeProvider(null);
  process.env.REACT_APP_WALLET_MODE = originalMode;
  jest.useRealTimers();
});

test("local mode connects and keeps the session account", async () => {
  stop = startWalletAccess(); await flush(); await verifyWalletAccess();
  expect(getWalletAccess().status).toBe("connected");
  expect(getWalletSessionAccount()).toBe(address.toLowerCase());
});

test("background re-checks (poll and focus) stay connected, never publish checking, keep the account", async () => {
  stop = startWalletAccess(); await flush(); await verifyWalletAccess();
  const statuses = [];
  const off = subscribeWalletAccess(() => statuses.push(getWalletAccess().status));
  const before = getWalletAccess();
  raw.request.mockClear();

  for (const fire of [
    () => jest.advanceTimersByTime(5000),
    () => window.dispatchEvent(new Event("focus")),
    () => window.dispatchEvent(new Event("pageshow")),
    () => document.dispatchEvent(new Event("visibilitychange")),
  ]) {
    fire();
    expect(getWalletAccess().status).toBe("connected"); // synchronously, before the re-check settles
    await flush();
    expect(getWalletAccess().status).toBe("connected");
    expect(getWalletSessionAccount()).toBe(address.toLowerCase());
  }
  expect(raw.request).toHaveBeenCalled(); // really re-verified
  expect(statuses).not.toContain("checking");
  expect(statuses).toEqual([]); // no publish at all
  expect(getWalletAccess()).toBe(before);
  off();
});
