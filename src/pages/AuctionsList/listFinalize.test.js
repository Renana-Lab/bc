import { pickAuctionToFinalize } from "./listFinalize";

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
