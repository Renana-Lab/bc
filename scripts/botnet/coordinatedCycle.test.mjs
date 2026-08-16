import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateCycleCandidates,
  clampBidsPerCycle,
  getBidDecision,
} from "../../src/botnet/cyclePlanner.mjs";

const address = (index) => `0x${index.toString(16).padStart(40, "0")}`;
const strategy = (limit) => ({
  maxBidsPerCycle: limit,
  maxBidWei: 2000n,
  outbidByWei: 10n,
  maxMinContributionWei: 2000n,
  minTimeRemainingSec: 20,
  skipIfWinning: true,
});
const auction = (index) => ({
  address: address(index),
  minimumContribution: "100",
  approversCount: 0,
  manager: address(index + 10000),
  highestBid: "0",
  highestBidder: address(0),
  endTimeSec: 2000001000 + index,
  closed: false,
});

test("four bots share ten auctions without duplicate primary or reserve work", () => {
  const bots = Array.from({ length: 4 }, (_, index) => ({
    id: `bot-${index}`,
    wallet: address(index + 100),
    strategy: strategy(1),
  }));
  const result = allocateCycleCandidates({
    bots,
    auctions: Array.from({ length: 10 }, (_, index) => auction(index + 1)),
    nowSec: 2000000000,
  });
  const assigned = Object.values(result.assignments).flatMap((value) => [
    ...value.primary,
    ...value.reserve,
  ]);
  assert.equal(assigned.length, 8);
  assert.equal(new Set(assigned.map((item) => item.address)).size, assigned.length);
});

test("stress plans 100 bots against only 50 active auctions", () => {
  const bots = Array.from({ length: 100 }, (_, index) => ({
    id: `bot-${index}`,
    wallet: address(index + 100),
    strategy: strategy((index % 5) + 1),
  }));
  const result = allocateCycleCandidates({
    bots,
    auctions: Array.from({ length: 50 }, (_, index) => auction(index + 1)),
    nowSec: 2000000000,
  });
  const assigned = Object.values(result.assignments).flatMap((value) => [
    ...value.primary,
    ...value.reserve,
  ]);
  assert.ok(assigned.length <= 50);
  assert.equal(new Set(assigned.map((item) => item.address)).size, assigned.length);
  assert.ok(result.candidatesEvaluated < 100 * 1050);
  assert.ok(result.candidatesEvaluated < 500, "saturated lists should stop scanning early");
});

test("rotating cursor shares scarce auctions fairly across bots", () => {
  const bots = Array.from({ length: 4 }, (_, index) => ({
    id: `bot-${index}`,
    wallet: address(index + 100),
    strategy: strategy(1),
  }));
  const auctions = [auction(1), auction(2)];
  const first = allocateCycleCandidates({ bots, auctions, nowSec: 2000000000, cursor: 0 });
  const second = allocateCycleCandidates({
    bots,
    auctions,
    nowSec: 2000000000,
    cursor: first.nextCursor,
  });
  const assignedBotIds = (plan) => Object.entries(plan.assignments)
    .filter(([, assignment]) => assignment.primary.length)
    .map(([botId]) => botId);
  assert.notDeepEqual(assignedBotIds(first), assignedBotIds(second));
});

test("bid limits and budget accounting remain deterministic in Node", () => {
  assert.equal(clampBidsPerCycle(0), 1);
  assert.equal(clampBidsPerCycle(9), 5);
  const decision = getBidDecision({
    ...auction(1),
    isActive: true,
    isManager: false,
    isWinner: false,
    secondsLeft: 60,
    approversCount: 1,
    highestBid: "500",
    myBid: "480",
  }, 30n, strategy(1));
  assert.deepEqual(decision, { bid: true, amountWei: 30n, targetBid: 510n });
});

test("planner covers exact deadline and minimum-time boundaries", () => {
  const bot = { id: "boundary-bot", wallet: address(100), strategy: strategy(1) };
  const nowSec = 2000000000;
  const result = allocateCycleCandidates({
    bots: [bot],
    auctions: [
      { ...auction(1), endTimeSec: nowSec },
      { ...auction(2), endTimeSec: nowSec + 19 },
      { ...auction(3), endTimeSec: nowSec + 20 },
    ],
    nowSec,
    reservePerSlot: 0,
  });
  assert.deepEqual(
    result.assignments[bot.id].primary.map((item) => item.address),
    [auction(3).address],
  );
});

test("exact budget and maximum bid limits are accepted without overspending", () => {
  const decision = getBidDecision({
    ...auction(1),
    isActive: true,
    isManager: false,
    isWinner: false,
    secondsLeft: 20,
    approversCount: 1,
    highestBid: "1990",
    myBid: "0",
  }, 2000n, strategy(1));
  assert.deepEqual(decision, { bid: true, amountWei: 2000n, targetBid: 2000n });
});

test("seller, current winner, closed, and malformed-time auctions are never assigned", () => {
  const bot = { id: "guarded-bot", wallet: address(100), strategy: strategy(5) };
  const nowSec = 2000000000;
  const blocked = [
    { ...auction(1), manager: bot.wallet },
    { ...auction(2), highestBidder: bot.wallet, highestBid: "100", approversCount: 1 },
    { ...auction(3), closed: true },
    { ...auction(4), endTimeSec: 0 },
  ];
  const result = allocateCycleCandidates({ bots: [bot], auctions: blocked, nowSec });
  assert.equal(result.assignments[bot.id].primary.length, 0);
  assert.equal(result.assignments[bot.id].reserve.length, 0);
});
