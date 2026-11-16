import { createAutoWithdraw, concernsAccount } from "./autoWithdraw.mjs";
import { observeAuctions } from "../auctionObserver.mjs";

const ME = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const auction = (n, extra = {}) => ({ address: `0x${String(n).repeat(40)}`, closed: true, manager: OTHER, highestBidder: OTHER, addresses: [ME], isRefunded: false, ...extra });
const settle = async (handle) => { await handle.idle(); await Promise.resolve(); };

const setup = (stateFor) => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const run = (kind) => async (address) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    calls.push([kind, address]);
    active -= 1;
  };
  const handle = createAutoWithdraw({
    getAccount: () => ME,
    readState: async (address) => stateFor(address),
    withdrawRefund: run("refund"), withdrawSeller: run("seller"),
  });
  return { handle, calls, maxActive: () => maxActive };
};
const loser = { closed: true, cancelled: false, manager: OTHER, participated: true, bid: 5n, isHighestBidder: false, sellerOwed: 0n };

afterEach(() => jest.restoreAllMocks());

test("a closed auction the participant lost is refunded once, however often the list refreshes", async () => {
  const t = setup(() => loser);
  const list = [auction(3)];
  observeAuctions(list, ME);
  observeAuctions(list, ME);
  observeAuctions([...list], ME);
  await settle(t.handle);
  expect(t.calls).toEqual([["refund", list[0].address]]);
  t.handle.stop();
});

test("a seller with a deferred payment withdraws it; the winner and an open auction do nothing", async () => {
  const states = {
    [auction(4).address]: { ...loser, manager: ME, participated: false, bid: 0n, sellerOwed: 9n },
    [auction(5).address]: { ...loser, isHighestBidder: true }, // winner: no refund
    [auction(6).address]: { ...loser, closed: false }, // not closed on chain
    [auction(7).address]: { ...loser, bid: 0n }, // nothing to refund
  };
  const t = setup((address) => states[address]);
  observeAuctions([auction(4, { manager: ME, addresses: [] }), auction(5, { highestBidder: ME }), auction(6), auction(7), auction(8, { closed: false })], ME);
  await settle(t.handle);
  expect(t.calls).toEqual([["seller", auction(4).address]]);
  t.handle.stop();
});

test("a cancelled auction refunds the leader too", async () => {
  const t = setup(() => ({ ...loser, cancelled: true, isHighestBidder: true }));
  observeAuctions([auction(9, { highestBidder: ME })], ME);
  await settle(t.handle);
  expect(t.calls).toEqual([["refund", auction(9).address]]);
  t.handle.stop();
});

test("withdrawals run one at a time and a failing one (nothing to withdraw) never stops the rest", async () => {
  const states = { [auction(1).address]: loser, [auction(2).address]: loser, [auction(3).address]: loser };
  const order = [];
  let active = 0; let maxActive = 0;
  const handle = createAutoWithdraw({
    getAccount: () => ME, readState: async (address) => states[address],
    withdrawSeller: async () => {},
    withdrawRefund: async (address) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(address); active -= 1;
      if (address === auction(1).address) throw new Error("No refund available");
    },
  });
  observeAuctions([auction(1), auction(2), auction(3)], ME);
  await handle.idle();
  expect(order).toEqual([auction(1).address, auction(2).address, auction(3).address]);
  expect(maxActive).toBe(1);
  handle.stop();
});

test("auctions of other people, already refunded ones and placeholders are skipped; probes are always checked", async () => {
  const t = setup(() => loser);
  observeAuctions([auction(1, { addresses: [OTHER] }), auction(2, { isRefunded: true }), auction(3, { isReadPlaceholder: true })], ME);
  await settle(t.handle);
  expect(t.calls).toEqual([]);
  observeAuctions([{ address: auction(4).address, closed: true, probe: true }], ME);
  await settle(t.handle);
  expect(t.calls).toEqual([["refund", auction(4).address]]);
  expect(concernsAccount({ addresses: [] }, ME)).toBe(false);
  t.handle.stop();
});

test("a probe that finds the auction not closed yet is looked at again next time", async () => {
  let closed = false;
  const t = setup(() => ({ ...loser, closed }));
  const probe = [{ address: auction(1).address, closed: true, probe: true }];
  observeAuctions(probe, ME);
  await settle(t.handle);
  expect(t.calls).toEqual([]);
  closed = true;
  observeAuctions(probe, ME);
  await settle(t.handle);
  expect(t.calls).toHaveLength(1);
  t.handle.stop();
});

test("drain finishes queued withdrawals, retries a failed one, and reports whether anything is still stuck", async () => {
  let fail = true;
  const sent = [];
  const handle = createAutoWithdraw({
    getAccount: () => ME, readState: async () => loser, withdrawSeller: async () => {},
    withdrawRefund: async (address) => { if (fail) throw new Error("insufficient funds"); sent.push(address); },
  });
  observeAuctions([auction(1)], ME);
  expect(await handle.drain()).toBe(false); // failed, retried once, still stuck
  expect(handle.blocked.size).toBe(1);
  fail = false;
  expect(await handle.drain()).toBe(true);
  expect(sent).toEqual([auction(1).address]);
  expect(handle.blocked.size).toBe(0);
  handle.stop();
});

test("drain waits (bounded, once) for the first look at the auctions", async () => {
  const handle = createAutoWithdraw({ getAccount: () => ME, readState: async () => loser, withdrawRefund: async () => {}, withdrawSeller: async () => {} });
  let release;
  const wait = jest.fn(() => new Promise((resolve) => { release = resolve; }));
  const draining = handle.drain({ waitForObservationMs: 20_000, wait });
  observeAuctions([auction(2)], ME);
  expect(await draining).toBe(true);
  expect(wait).toHaveBeenCalledTimes(1);
  const timedOut = createAutoWithdraw({ getAccount: () => ME, readState: async () => loser, withdrawRefund: async () => {}, withdrawSeller: async () => {} });
  const quick = jest.fn(async () => {});
  await timedOut.drain({ waitForObservationMs: 20_000, wait: quick });
  await timedOut.drain({ waitForObservationMs: 20_000, wait: quick });
  expect(quick).toHaveBeenCalledTimes(1); // no second wait after the timeout
  handle.stop(); timedOut.stop();
});
