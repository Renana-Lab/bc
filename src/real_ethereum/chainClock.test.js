import {
  chainNowMs,
  subscribeChainClock,
  syncChainClock,
  getChainClockOffsetMs,
  __resetChainClockForTests,
  SYNC_INTERVAL_MS,
} from "./chainClock";
import { readOnlyExecute } from "./readOnly";

jest.mock("./readOnly", () => ({ readOnlyExecute: jest.fn() }));

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const BASE = Date.parse("2026-01-01T00:00:00Z");
// Chain is 5 minutes ahead/behind the device clock depending on the test.
const mockBlock = (chainMs) =>
  readOnlyExecute.mockImplementation(async (op) =>
    op({ web3: { eth: { getBlock: async () => ({ timestamp: Math.floor(chainMs() / 1000) }) } } }),
  );

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(BASE);
  readOnlyExecute.mockReset();
  __resetChainClockForTests();
});
afterEach(() => {
  __resetChainClockForTests();
  jest.useRealTimers();
});

test("falls back to the device clock before the first sync", () => {
  expect(chainNowMs()).toBe(Date.now());
});

test.each([[5 * 60 * 1000], [-5 * 60 * 1000]])("applies the offset when the device clock is off by %i ms", async (skew) => {
  // Device clock = chain + skew.
  mockBlock(() => Date.now() - skew);
  await syncChainClock({ force: true });
  expect(Math.abs(getChainClockOffsetMs() + skew)).toBeLessThan(1000);
  expect(Math.abs(chainNowMs() - (Date.now() - skew))).toBeLessThan(1000);
});

test("a countdown ends at the chain end time, not the device end time", async () => {
  const skew = 5 * 60 * 1000; // device 5 minutes fast
  mockBlock(() => Date.now() - skew);
  await syncChainClock({ force: true });
  const endMs = chainNowMs() + 10_000; // 10 s left on chain
  expect(endMs - chainNowMs()).toBeGreaterThan(0);
  jest.advanceTimersByTime(10_500);
  expect(endMs - chainNowMs()).toBeLessThanOrEqual(0);
});

test("a failed sync keeps the last offset and never throws", async () => {
  mockBlock(() => Date.now() - 60_000);
  await syncChainClock({ force: true });
  const offset = getChainClockOffsetMs();
  readOnlyExecute.mockRejectedValue(new Error("rpc down"));
  await expect(syncChainClock({ force: true })).resolves.toBe(offset);
  expect(getChainClockOffsetMs()).toBe(offset);
});

test("many subscribers share one in-flight request and sync at most every 30 s", async () => {
  mockBlock(() => Date.now());
  const offs = Array.from({ length: 10 }, () => subscribeChainClock(() => {}));
  await flush();
  expect(readOnlyExecute).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(SYNC_INTERVAL_MS - 1000);
  await flush();
  expect(readOnlyExecute).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1500);
  await flush();
  expect(readOnlyExecute).toHaveBeenCalledTimes(2);
  offs.forEach((off) => off());
});
