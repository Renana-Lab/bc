import {
  chainNowMs,
  subscribeChainClock,
  NOTIFY_THRESHOLD_MS,
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

describe("refinements", () => {
  afterEach(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

  test("the forced 30 s sync is skipped while the tab is hidden and resumes when visible", async () => {
    mockBlock(() => Date.now());
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const off = subscribeChainClock(() => {});
    await flush();
    expect(readOnlyExecute).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    jest.advanceTimersByTime(SYNC_INTERVAL_MS * 3); await flush();
    expect(readOnlyExecute).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    jest.advanceTimersByTime(SYNC_INTERVAL_MS); await flush();
    expect(readOnlyExecute).toHaveBeenCalledTimes(2);
    off();
  });

  test("subscribers are notified only when the offset moves by more than 250 ms", async () => {
    let skew = 0;
    mockBlock(() => Date.now() - skew);
    const listener = jest.fn();
    const off = subscribeChainClock(listener);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1); // first sync
    // Block timestamps are whole seconds; use steps that survive that rounding.
    skew = -1000; // chain 1 s further ahead: a real change
    jest.advanceTimersByTime(SYNC_INTERVAL_MS); await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(SYNC_INTERVAL_MS); await flush(); // same offset again
    expect(listener).toHaveBeenCalledTimes(2);
    expect(NOTIFY_THRESHOLD_MS).toBe(250);
    off();
  });

  test("keeps the largest offset of the last 5 syncs, since block age only shrinks it", async () => {
    let age = 0; // how old the latest block is, in ms
    mockBlock(() => Date.now() + 10 * 60 * 1000 - age);
    const off = subscribeChainClock(() => {});
    await flush();
    const best = getChainClockOffsetMs();
    for (const next of [3000, 1000]) {
      age = next;
      jest.advanceTimersByTime(SYNC_INTERVAL_MS); await flush();
      expect(getChainClockOffsetMs()).toBe(best); // an older block does not pull the offset back
    }
    for (let i = 0; i < 5; i += 1) { // once the best sample leaves the window it can drop
      age = 3000;
      jest.advanceTimersByTime(SYNC_INTERVAL_MS); await flush();
    }
    expect(getChainClockOffsetMs()).toBeLessThan(best);
    off();
  });

  test("the sync interval is cleared when the last subscriber leaves", async () => {
    mockBlock(() => Date.now());
    const a = subscribeChainClock(() => {});
    const b = subscribeChainClock(() => {});
    await flush();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    a();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    b();
    expect(jest.getTimerCount()).toBe(0);
    const calls = readOnlyExecute.mock.calls.length;
    jest.advanceTimersByTime(SYNC_INTERVAL_MS * 3); await flush();
    expect(readOnlyExecute.mock.calls.length).toBe(calls);
  });
});
