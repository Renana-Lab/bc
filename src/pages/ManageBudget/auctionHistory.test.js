import {
  buildAuditRows,
  buildBidRows,
  buildLedgerRows,
  findOriginalMinimum,
  readAuctionHistory,
} from "./auctionHistory";

const C = "0x00000000000000000000000000000000000000c1";
const OTHER = "0x00000000000000000000000000000000000000c2";
const F = "0x00000000000000000000000000000000000000f0";
const U1 = "0x0000000000000000000000000000000000000001";
const U2 = "0x0000000000000000000000000000000000000002";
const ADMIN = "0x00000000000000000000000000000000000000aa";

let tx = 0;
const log = (event, address, block, returnValues) => ({ event, address, blockNumber: block, logIndex: 0, transactionHash: `0x${++tx}`, returnValues });

const campaignLogs = [
  log("BidRecorded", C, 105, { bidder: U1, amount: "10", cumulativeBid: "10", budgetBefore: "100", budgetAfter: "90", time: "1700000100", previousHighestBidder: U2, previousHighestBid: "0" }),
  log("BidRecorded", C, 110, { bidder: U2, amount: "15", cumulativeBid: "15", budgetBefore: "50", budgetAfter: "35", time: "1700000200", previousHighestBidder: U1, previousHighestBid: "10" }),
  log("RefundProcessed", C, 120, { contributor: U1, amount: "10" }),
];
const factoryLogs = [
  log("AuctionCreatedDetailed", F, 101, { campaignAddress: C, seller: ADMIN, minimum: "5", endTime: "1700001000", dataDescription: "d" }),
  log("BudgetChanged", F, 105, { campaignAddress: C, user: U1, amount: "10", increase: false, budgetBefore: "100", budgetAfter: "90" }),
  log("BudgetChanged", F, 106, { campaignAddress: OTHER, user: U1, amount: "3", increase: false, budgetBefore: "90", budgetAfter: "87" }),
  log("BudgetChanged", F, 107, { campaignAddress: OTHER, user: ADMIN, amount: "3", increase: false, budgetBefore: "9", budgetAfter: "6" }),
  log("UserBudgetSet", F, 108, { user: U2, total: "500", available: "500", by: ADMIN }),
  log("MinimumChanged", F, 102, { campaign: C, oldMinimum: "5", newMinimum: "7", by: ADMIN }),
  log("MinimumChanged", F, 103, { campaign: OTHER, oldMinimum: "1", newMinimum: "2", by: ADMIN }),
  log("AuctionCancelled", F, 121, { campaign: C, by: ADMIN, note: "bad", fundsReleased: true }),
];

// Serves logs per block range the way eth_getLogs would.
const fakeReader = ({ latest = 130, failFrom = null } = {}) => ({
  getLatestBlock: async () => latest,
  readLogs: async ({ kind, names, from, to }) => {
    if (failFrom !== null && from <= failFrom && failFrom <= to) throw new Error("range failed");
    const source = kind === "campaign" ? campaignLogs : factoryLogs;
    return source.filter((entry) => names.includes(entry.event) && entry.blockNumber >= from && entry.blockNumber <= to);
  },
});

test("readAuctionHistory builds bids, ledger and audit rows from a fake log reader", async () => {
  const history = await readAuctionHistory({ campaign: C, factoryAddress: F, reader: fakeReader(), lookback: 100 });
  expect(history.bids.map((bid) => [bid.bidder, bid.amount, bid.cumulative, bid.budgetBefore, bid.budgetAfter])).toEqual([
    [U1, "10", "10", "100", "90"],
    [U2, "15", "15", "50", "35"],
  ]);
  expect(history.bids[0].timeSec).toBe(1700000100);
  // ledger: this auction's BudgetChanged, a bidder's budget change elsewhere, a bidder's UserBudgetSet, the refund
  expect(history.ledger.map((row) => row.type)).toEqual(["BudgetChanged", "BudgetChanged", "UserBudgetSet", "RefundProcessed"]);
  expect(history.ledger.some((row) => row.who === ADMIN.toLowerCase())).toBe(false);
  expect(history.audit.map((row) => row.type)).toEqual(["MinimumChanged", "AuctionCancelled"]);
  expect(history.originalMinimum).toBe("5");
  expect(history.healthNote).toBe("");
});

test("a failed range or a truncated lookback is reported as incomplete history", async () => {
  const failed = await readAuctionHistory({ campaign: C, factoryAddress: F, reader: fakeReader({ failFrom: 105 }), lookback: 100 });
  expect(failed.healthNote).toMatch(/ranges failed/);
  const truncated = await readAuctionHistory({ campaign: C, factoryAddress: F, reader: fakeReader({ latest: 100000 }), lookback: 100000 });
  expect(truncated.healthNote).toMatch(/shortened/);
});

test("payloads are never part of the history: only the documented event names are requested", async () => {
  const asked = new Set();
  const reader = { getLatestBlock: async () => 10, readLogs: async ({ names }) => { names.forEach((name) => asked.add(name)); return []; } };
  await readAuctionHistory({ campaign: C, factoryAddress: F, reader, lookback: 10 });
  expect([...asked].sort()).toEqual([
    "AuctionCancelled", "AuctionClosedEarly", "AuctionCreatedDetailed", "AuctionHiddenChanged", "BidRecorded", "BudgetChanged",
    "MinimumChanged", "RefundProcessed", "SellerPaid", "SellerPaymentDeferred", "UserBudgetSet",
  ]);
});

test("original minimum falls back to the oldest MinimumChanged old value", () => {
  expect(findOriginalMinimum({ campaign: C, factoryEvents: [] })).toBe("");
  expect(buildBidRows([])).toEqual([]);
  expect(buildLedgerRows({ campaign: C })).toEqual([]);
  expect(buildAuditRows({ campaign: C })).toEqual([]);
});
