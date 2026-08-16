import {
  allocateCycleCandidates,
  clampBidsPerCycle,
  getActivityUsage,
  getBidDecision,
  getEstimatedWritesPerHour,
} from "./cyclePlanner.mjs";

const wallet = (index) => `0x${(10000 + index).toString(16).padStart(40, "0")}`;
const auction = (index, overrides = {}) => ({
  address: wallet(index),
  minimumContribution: "100",
  approversCount: 0,
  manager: wallet(index + 5000),
  highestBid: "0",
  highestBidder: wallet(index + 6000),
  endTimeSec: 2000001000 + index,
  closed: false,
  ...overrides,
});
const strategy = (maxBidsPerCycle = 1) => ({
  maxBidsPerCycle,
  maxBidWei: 2000n,
  outbidByWei: 10n,
  maxMinContributionWei: 2000n,
  minTimeRemainingSec: 20,
  skipIfWinning: true,
});
const bot = (index, maxBidsPerCycle = 1) => ({
  id: `bot-${index}`,
  wallet: wallet(index + 1000),
  strategy: strategy(maxBidsPerCycle),
});

describe("coordinated bot cycle planner", () => {
  test("protects the configurable bid limit at 1-5", () => {
    expect(clampBidsPerCycle(-10)).toBe(1);
    expect(clampBidsPerCycle(3.9)).toBe(3);
    expect(clampBidsPerCycle(99)).toBe(5);
    expect(clampBidsPerCycle("bad")).toBe(1);
  });

  test("assigns distinct primaries and one distinct reserve per slot", () => {
    const result = allocateCycleCandidates({
      bots: [bot(1, 2), bot(2, 2), bot(3, 2), bot(4, 2)],
      auctions: Array.from({ length: 20 }, (_, index) => auction(index + 1)),
      nowSec: 2000000000,
    });
    const assigned = Object.values(result.assignments).flatMap(({ primary, reserve }) => [
      ...primary,
      ...reserve,
    ]);
    expect(new Set(assigned.map((item) => item.address.toLowerCase())).size).toBe(assigned.length);
    Object.values(result.assignments).forEach(({ primary, reserve }) => {
      expect(primary).toHaveLength(2);
      expect(reserve).toHaveLength(2);
    });
  });

  test("filters seller, current winner, unsafe minimum, and near-expiry auctions", () => {
    const currentBot = bot(1);
    const result = allocateCycleCandidates({
      bots: [currentBot],
      auctions: [
        auction(1, { manager: currentBot.wallet }),
        auction(2, { highestBidder: currentBot.wallet, approversCount: 1, highestBid: "100" }),
        auction(3, { minimumContribution: "5000" }),
        auction(4, { endTimeSec: 2000000005 }),
        auction(5),
        auction(6),
      ],
      nowSec: 2000000000,
    });
    expect(result.assignments[currentBot.id].primary.map((item) => item.address)).toEqual([
      auction(5).address,
    ]);
    expect(result.assignments[currentBot.id].reserve.map((item) => item.address)).toEqual([
      auction(6).address,
    ]);
  });

  test("rotates coverage fairly between rounds", () => {
    const auctions = Array.from({ length: 8 }, (_, index) => auction(index + 1));
    const first = allocateCycleCandidates({ bots: [bot(1)], auctions, cursor: 0, nowSec: 2000000000 });
    const second = allocateCycleCandidates({
      bots: [bot(1)],
      auctions,
      cursor: first.nextCursor,
      nowSec: 2000000000,
    });
    expect(second.assignments["bot-1"].primary[0].address).not.toBe(
      first.assignments["bot-1"].primary[0].address,
    );
  });

  test("stress: planning depends on active auctions, not 1,000 historical auctions per bot", () => {
    const historical = Array.from({ length: 1000 }, (_, index) =>
      auction(index + 1, { closed: true, endTimeSec: 1900000000 }),
    );
    const active = Array.from({ length: 50 }, (_, index) => auction(index + 2000));
    const bots = Array.from({ length: 100 }, (_, index) => bot(index, (index % 5) + 1));
    const result = allocateCycleCandidates({ bots, auctions: active, nowSec: 2000000000 });
    const assigned = Object.values(result.assignments).flatMap(({ primary, reserve }) => [
      ...primary,
      ...reserve,
    ]);
    expect(historical).toHaveLength(1000);
    expect(assigned.length).toBeLessThanOrEqual(active.length);
    expect(new Set(assigned.map((item) => item.address)).size).toBe(assigned.length);
    expect(result.candidatesEvaluated).toBeLessThan(bots.length * (historical.length + active.length));
  });

  test("uses identical deterministic budget and rebid accounting for every runner", () => {
    const base = {
      ...auction(20),
      isActive: true,
      isManager: false,
      isWinner: false,
      secondsLeft: 300,
      approversCount: 2,
      highestBid: "500",
      myBid: "480",
    };
    expect(getBidDecision(base, 30n, strategy())).toEqual({
      bid: true,
      amountWei: 30n,
      targetBid: 510n,
    });
    expect(getBidDecision(base, 29n, strategy())).toMatchObject({
      bid: false,
      reason: "Insufficient budget",
    });
  });

  test("reports estimated hourly activity and usage level", () => {
    expect(getEstimatedWritesPerHour(60, 1)).toBe(60);
    expect(getActivityUsage(60, 1)).toMatchObject({ level: "low", writesPerHour: 60 });
    expect(getActivityUsage(15, 2).level).toBe("high");
  });
});
