import { getWalletAccess, startWalletAccess, verifyWalletAccess, requireWalletAccess, discoverWalletProvider, walletDiagnostic } from "./walletAccess";
import { createWalletTransport } from "./walletTransport";

const address = "0x1234567890abcdef1234567890abcdef12345678";
let stop;
let provider;
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };
const emit = (name, value) => provider.handlers[name]?.(value);
beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  provider = {
    isMetaMask: true, handlers: {},
    _metamask: { isUnlocked: jest.fn().mockResolvedValue(true) },
    request: jest.fn().mockResolvedValue([address]),
    on: jest.fn((name, fn) => { provider.handlers[name] = fn; }),
    removeListener: jest.fn((name, fn) => { if (provider.handlers[name] === fn) delete provider.handlers[name]; }),
  };
  window.ethereum = provider;
});
afterEach(() => { stop?.(); stop = null; delete window.ethereum; jest.useRealTimers(); });
test("missing wallet never grants access", async () => {
  delete window.ethereum; stop = startWalletAccess();
  expect((await verifyWalletAccess()).status).toBe("unavailable");
});
test("locked wallet cannot grant access with a cached address", async () => {
  provider._metamask.isUnlocked.mockResolvedValue(false); stop = startWalletAccess();
  expect((await verifyWalletAccess()).status).toBe("locked");
  expect(provider.request).not.toHaveBeenCalled();
});
test.each([null, {}, ["garbage"], [null]])("malformed account response %p fails closed", async (accounts) => {
  provider.request.mockResolvedValue(accounts); stop = startWalletAccess();
  expect((await verifyWalletAccess()).status).toBe("verification-failed");
});
test("an empty authorized account list is blocked", async () => {
  provider.request.mockResolvedValue([]); stop = startWalletAccess();
  expect((await verifyWalletAccess()).status).toBe("unauthorized");
});
test("disconnect invalidates a pending successful response", async () => {
  let resolve;
  provider.request.mockImplementation(() => new Promise((r) => { resolve = r; }));
  stop = startWalletAccess(); await flush();
  emit("disconnect"); resolve([address]); await flush();
  expect(getWalletAccess().status).toBe("unavailable");
});
test("account event invalidates old requests and never grants access itself", async () => {
  let resolve;
  provider.request.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  stop = startWalletAccess(); await flush();
  provider._metamask.isUnlocked.mockResolvedValue(false);
  emit("accountsChanged", [address]); resolve([address]); await flush();
  expect(getWalletAccess().status).toBe("locked");
});
test("one request is shared and stalled verification expires access", async () => {
  stop = startWalletAccess(); await verifyWalletAccess();
  provider.request.mockImplementation(() => new Promise(() => {}));
  const a = verifyWalletAccess(); const b = verifyWalletAccess(); expect(a).toBe(b);
  await flush(); jest.advanceTimersByTime(3000); await flush();
  expect(getWalletAccess().status).not.toBe("connected");
});
test("background suspension hides access and late results cannot restore it", async () => {
  stop = startWalletAccess(); await verifyWalletAccess();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(getWalletAccess().status).toBe("checking");
  await expect(requireWalletAccess()).rejects.toThrow();
});
test("announced identity wins over an injected impersonator", async () => {
  stop = startWalletAccess(); await verifyWalletAccess();
  const actual = { ...provider, request: jest.fn().mockResolvedValue([address]) };
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { rdns: "io.metamask" }, provider: actual } }));
  expect(discoverWalletProvider()).toBe(actual);
  expect(getWalletAccess().status).toBe("checking");
  await verifyWalletAccess(); expect(getWalletAccess().provider).toBe(actual);
});
test("announced wallet without unlock verification is blocked", async () => {
  stop = startWalletAccess();
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { rdns: "io.metamask" }, provider: { request: provider.request } } }));
  expect((await verifyWalletAccess()).status).toBe("verification-failed");
});
test("Strict Mode setup cleanup does not duplicate listeners or timers", async () => {
  stop = startWalletAccess(); await verifyWalletAccess(); stop();
  expect(Object.keys(provider.handlers)).toHaveLength(0);
  stop = startWalletAccess(); await verifyWalletAccess();
  expect(Object.keys(provider.handlers)).toHaveLength(3);
  expect(jest.getTimerCount()).toBe(2);
});
test("transport denies locked transactions and never forwards them to fallback", async () => {
  stop = startWalletAccess(); await verifyWalletAccess();
  provider._metamask.isUnlocked.mockResolvedValue(false);
  const fallback = { send: jest.fn() }; const transport = createWalletTransport(fallback);
  const result = await new Promise((resolve) => transport.send({ id: 1, method: "eth_sendTransaction", params: [{ from: address }] }, (error) => resolve(error)));
  expect(result).toBeInstanceOf(Error); expect(fallback.send).not.toHaveBeenCalled();
  expect(provider.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "eth_sendTransaction" }));
});
test("diagnostic excludes account addresses", async () => {
  stop = startWalletAccess(); await verifyWalletAccess(); expect(walletDiagnostic()).not.toContain(address);
});
test("late injection becomes verifiable on the next poll", async () => {
  delete window.ethereum; stop = startWalletAccess(); expect(getWalletAccess().status).toBe("unavailable");
  window.ethereum = provider; jest.advanceTimersByTime(1000); await flush();
  expect(getWalletAccess().status).toBe("connected");
});
test("legacy provider replacement during verification cannot admit the previous wallet", async () => {
  let resolve; provider.request.mockImplementation(() => new Promise((r) => { resolve = r; }));
  stop = startWalletAccess(); await flush();
  window.ethereum = { ...provider }; resolve([address]); await flush();
  expect(getWalletAccess().status).toBe("checking");
});
test("multiple ambiguous legacy providers remain blocked", async () => {
  window.ethereum = { providers: [provider, { ...provider }] }; stop = startWalletAccess();
  expect(getWalletAccess().status).toBe("unavailable");
});
test("page cache restoration requires verification again", async () => {
  stop = startWalletAccess(); await verifyWalletAccess();
  window.dispatchEvent(new Event("pagehide")); expect(getWalletAccess().status).toBe("checking");
  provider._metamask.isUnlocked.mockResolvedValue(false);
  window.dispatchEvent(new Event("pageshow")); await flush(); expect(getWalletAccess().status).toBe("locked");
});
test("wallet locking between account and final unlock checks is denied", async () => {
  provider._metamask.isUnlocked.mockResolvedValueOnce(true).mockResolvedValue(false);
  stop = startWalletAccess(); await verifyWalletAccess(); expect(getWalletAccess().status).toBe("locked");
});
