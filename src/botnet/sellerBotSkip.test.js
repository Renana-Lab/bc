import { allocateCycleCandidates, getBidDecision, isSellerBotAuction } from "./cyclePlanner.mjs";
import { readSellerBotCache, readSellerBotStrategy, writeSellerBotCache, SELLER_BOTS_KEY } from "./sellerBotList";

const SELLER = `0x${"5".repeat(40)}`;
const OTHER = `0x${"6".repeat(40)}`;
const strategy = (extra = {}) => ({ maxBidsPerCycle: 1, maxBidWei: 2000n, outbidByWei: 10n, maxMinContributionWei: 2000n, minTimeRemainingSec: 20, skipIfWinning: true, ...extra });
const auction = (manager, index = 1) => ({
  address: `0x${(1000 + index).toString(16).padStart(40, "0")}`, manager, minimumContribution: "100", approversCount: 0, highestBid: "0", highestBidder: OTHER, endTimeSec: 2000001000, closed: false,
  isActive: true, secondsLeft: 600, isManager: false, isWinner: false, myBid: 0n,
});

describe("buyer bots skip seller-bot auctions", () => {
  test("decision: 'Seller is a bot' by default, case-insensitively", () => {
    const withList = strategy({ sellerBotAddresses: [SELLER.toUpperCase().replace("0X", "0x")] });
    expect(getBidDecision(auction(SELLER), 1000n, withList)).toEqual({ bid: false, reason: "Seller is a bot" });
    expect(getBidDecision(auction(OTHER), 1000n, withList).bid).toBe(true);
  });
  test("allowBuyerBotsOnSellerAuctions: true lifts the skip", () => {
    const allowed = strategy({ sellerBotAddresses: [SELLER], allowBuyerBotsOnSellerAuctions: true });
    expect(getBidDecision(auction(SELLER), 1000n, allowed).bid).toBe(true);
    expect(isSellerBotAuction(auction(SELLER), allowed)).toBe(false);
  });
  test("without a list nothing is skipped (the default for installs without seller bots)", () => {
    expect(getBidDecision(auction(SELLER), 1000n, strategy()).bid).toBe(true);
    expect(isSellerBotAuction(auction(SELLER), strategy({ sellerBotAddresses: [] }))).toBe(false);
  });
  test("allocation never assigns a seller-bot auction unless allowed", () => {
    const bots = (s) => [{ id: "b1", wallet: `0x${"7".repeat(40)}`, strategy: s, budgetWei: 5000n }];
    const auctions = [auction(SELLER, 1), auction(OTHER, 2)];
    const blocked = allocateCycleCandidates({ bots: bots(strategy({ sellerBotAddresses: [SELLER] })), auctions, nowSec: 2000000000 });
    expect(blocked.assignments.b1.primary.map((a) => a.manager)).toEqual([OTHER]);
    const only = allocateCycleCandidates({ bots: bots(strategy({ sellerBotAddresses: [SELLER] })), auctions: [auction(SELLER, 1)], nowSec: 2000000000 });
    expect(only.assignments.b1.primary).toEqual([]);
    const allowed = allocateCycleCandidates({ bots: bots(strategy({ sellerBotAddresses: [SELLER], allowBuyerBotsOnSellerAuctions: true })), auctions: [auction(SELLER, 1)], nowSec: 2000000000 });
    expect(allowed.assignments.b1.primary).toHaveLength(1);
  });
});

describe("seller bot list cache", () => {
  beforeEach(() => window.localStorage.clear());
  test("round trip, lower-casing, bad values ignored, default allow false", () => {
    expect(readSellerBotStrategy()).toEqual({ sellerBotAddresses: [], allowBuyerBotsOnSellerAuctions: false });
    writeSellerBotCache({ addresses: [SELLER.toUpperCase().replace("0X", "0x"), "nope", SELLER], allowBuyerBotsOnSellerAuctions: false });
    expect(readSellerBotStrategy()).toEqual({ sellerBotAddresses: [SELLER], allowBuyerBotsOnSellerAuctions: false });
    writeSellerBotCache({ addresses: [SELLER], allowBuyerBotsOnSellerAuctions: true });
    expect(readSellerBotCache().allowBuyerBotsOnSellerAuctions).toBe(true);
    window.localStorage.setItem(SELLER_BOTS_KEY, "{broken");
    expect(readSellerBotStrategy()).toEqual({ sellerBotAddresses: [], allowBuyerBotsOnSellerAuctions: false });
  });
});
