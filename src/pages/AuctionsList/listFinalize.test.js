import { pickAuctionToFinalize, resolveFinalizeOutcome } from "./listFinalize";

const me = "0x00000000000000000000000000000000000000bb";
const other = "0x00000000000000000000000000000000000000cc";
const NOW = 1_000_000;
const auction = (address, over = {}) => ({
  address, endTime: NOW - 1000, closed: false, manager: other, highestBidder: other, addresses: [], ...over,
});
const pick = (auctions, over = {}) =>
  pickAuctionToFinalize({ auctions, account: me, nowMs: NOW, records: new Map(), inFlight: false, ...over });

test("picks an ended, open auction the user took part in (seller, leader or bidder)", () => {
  expect(pick([auction("0xa", { manager: me })]).address).toBe("0xa");
  expect(pick([auction("0xa", { highestBidder: me })]).address).toBe("0xa");
  expect(pick([auction("0xa", { addresses: [me.toUpperCase().replace("0X", "0x")] })]).address).toBe("0xa");
});

test("skips active, closed, placeholder and non-participant auctions, and a missing account", () => {
  const list = [
    auction("0x1", { endTime: NOW + 5000, manager: me }),
    auction("0x2", { closed: true, manager: me }),
    auction("0x3", { isReadPlaceholder: true, manager: me }),
    auction("0x4"),
  ];
  expect(pick(list)).toBeNull();
  expect(pick([auction("0x5", { manager: me })], { account: "" })).toBeNull();
});

test("one at a time: nothing is picked while a finalize is in flight", () => {
  expect(pick([auction("0xa", { manager: me })], { inFlight: true })).toBeNull();
});

test("once per session: an attempted auction is skipped and the next one is picked", () => {
  const list = [auction("0xa", { manager: me }), auction("0xb", { manager: me })];
  const records = new Map([["0xa", { attempts: 1, retryAtMs: null }]]);
  expect(pick(list, { records }).address).toBe("0xb");
  records.set("0xb", { attempts: 1, retryAtMs: null });
  expect(pick(list, { records })).toBeNull();
});

test("a not-ended retry is picked only once due and below 3 attempts", () => {
  const list = [auction("0xa", { manager: me })];
  expect(pick(list, { records: new Map([["0xa", { attempts: 1, retryAtMs: NOW + 1 }]]) })).toBeNull();
  expect(pick(list, { records: new Map([["0xa", { attempts: 1, retryAtMs: NOW }]]) }).address).toBe("0xa");
  expect(pick(list, { records: new Map([["0xa", { attempts: 3, retryAtMs: NOW - 1 }]]) })).toBeNull();
});

describe("resolveFinalizeOutcome (list not-ended retry)", () => {
  const endTimeMs = 1_000_000;
  test("a not-ended result schedules a retry at endTime + 3 s per attempt", () => {
    const out = resolveFinalizeOutcome({ result: { finalized: false, reason: "not-ended" }, attempts: 1, endTimeMs });
    expect(out).toEqual({ record: { attempts: 1, retryAtMs: endTimeMs + 3000 }, refreshList: false });
    expect(resolveFinalizeOutcome({ result: { finalized: false, reason: "not-ended" }, attempts: 2, endTimeMs }).record.retryAtMs)
      .toBe(endTimeMs + 6000);
  });

  test("a not-ended revert is retried the same way", () => {
    const out = resolveFinalizeOutcome({ error: new Error("execution reverted: Auction not ended yet"), attempts: 1, endTimeMs });
    expect(out.record.retryAtMs).toBe(endTimeMs + 3000);
    expect(out.refreshList).toBe(false);
  });

  test("after 3 attempts there is no further retry", () => {
    const out = resolveFinalizeOutcome({ result: { finalized: false, reason: "not-ended" }, attempts: 3, endTimeMs });
    expect(out.record).toEqual({ attempts: 3, retryAtMs: null });
  });

  test("success reloads the list; other results and errors are final and silent", () => {
    expect(resolveFinalizeOutcome({ result: { finalized: true, reason: "finalized" }, attempts: 1, endTimeMs }))
      .toEqual({ record: { attempts: 1, retryAtMs: null }, refreshList: true });
    expect(resolveFinalizeOutcome({ result: { finalized: false, reason: "already-closed" }, attempts: 1, endTimeMs }).refreshList).toBe(false);
    expect(resolveFinalizeOutcome({ error: new Error("insufficient funds"), attempts: 1, endTimeMs }))
      .toEqual({ record: { attempts: 1, retryAtMs: null }, refreshList: false });
  });

  test("a due retry is picked again by pickAuctionToFinalize, a final record is not", () => {
    const me = "0x00000000000000000000000000000000000000bb";
    const list = [{ address: "0xa", endTime: endTimeMs - 1, closed: false, manager: me, addresses: [] }];
    const { record } = resolveFinalizeOutcomeOnce();
    function resolveFinalizeOutcomeOnce() { return resolveFinalizeOutcome({ result: { finalized: false, reason: "not-ended" }, attempts: 1, endTimeMs }); }
    const records = new Map([["0xa", record]]);
    const pick = (nowMs) => pickAuctionToFinalize({ auctions: list, account: me, nowMs, records, inFlight: false });
    expect(pick(endTimeMs + 2999)).toBeNull();
    expect(pick(endTimeMs + 3000).address).toBe("0xa");
  });
});
