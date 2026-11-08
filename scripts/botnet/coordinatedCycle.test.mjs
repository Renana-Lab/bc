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
  assert.ok(result.candidatesEvaluated <= 100 * 50, "eligibility scans are bounded by active auctions");
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
  assert.deepEqual(decision, { bid: false, reason: "Insufficient budget" });
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
  assert.deepEqual(decision, { bid: true, amountWei: 2000n, targetBid: 2000n, budgetCostWei: 2000n });
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

test("cheapest means next cumulative bid, with random selection only among ties", () => {
  const bot = { id: "cheap", wallet: address(100), strategy: strategy(1), budgetWei: 2000n };
  const auctions = [
    { ...auction(1), minimumContribution: "1", highestBid: "500", approversCount: 1 },
    { ...auction(2), minimumContribution: "60" },
    { ...auction(3), minimumContribution: "70" },
    { ...auction(4), minimumContribution: "50", highestBid: "50", approversCount: 1 },
  ];
  const pick = (random) => allocateCycleCandidates({ bots: [bot], auctions, nowSec: 2000000000, reservePerSlot: 0, random }).assignments.cheap.primary[0];
  assert.equal(pick(() => 0.999).address, address(2));
  assert.equal(pick(() => 0.3).address, address(4));
  const changed = auctions.map(a => a.address === address(2) ? { ...a, highestBid: "100", approversCount: 1 } : a);
  const next = allocateCycleCandidates({ bots: [bot], auctions: changed, nowSec: 2000000000 });
  assert.equal(next.assignments.cheap.primary[0].address, address(4));
});

test("unfunded bots cannot reserve the cheapest auction from funded bots", () => {
  const bots = [
    { id: "empty", wallet: address(100), strategy: strategy(1), budgetWei: 0n },
    { id: "funded", wallet: address(101), strategy: strategy(1), budgetWei: 100n },
  ];
  const result = allocateCycleCandidates({ bots, auctions: [auction(1), { ...auction(2), minimumContribution: "200" }], nowSec: 2000000000 });
  assert.equal(result.assignments.empty.primary.length, 0);
  assert.equal(result.assignments.funded.primary[0].address, address(1));
});

test("ranks large prices precisely without assigning higher-priced primary or reserve bids", () => {
  const bot = { id: "large", wallet: address(100), strategy: { ...strategy(2), maxMinContributionWei: 10n ** 20n, maxBidWei: 10n ** 20n } };
  const auctions = ["9007199254740993", "9007199254740992", "9007199254740994", "9007199254740995"].map((value, index) => ({ ...auction(index + 1), minimumContribution: value }));
  const result = allocateCycleCandidates({ bots: [bot], auctions, nowSec: 2000000000 });
  assert.deepEqual(result.assignments.large.primary.map(a => a.minimumContribution), ["9007199254740992"]);
  assert.deepEqual(result.assignments.large.reserve.map(a => a.minimumContribution), []);
});

test("optional winner rebids reserve only the incremental budget", () => {
  const bot = { id: "winner", wallet: address(100), strategy: { ...strategy(1), skipIfWinning: false }, budgetWei: 10n };
  const result = allocateCycleCandidates({
    bots: [bot],
    auctions: [{ ...auction(1), highestBidder: bot.wallet, highestBid: "500", approversCount: 1 }],
    nowSec: 2000000000,
  });
  assert.equal(result.assignments.winner.primary[0].address, address(1));
});


test("reservations never send another bot to a higher price", () => {
  const bots = [100, 101, 102].map(i => ({ id: String(i), wallet: address(i), strategy: strategy(5), budgetWei: 2000n }));
  const cheap = { ...auction(1), minimumContribution: "50" };
  const dear = { ...auction(2), minimumContribution: "60" };
  const plan = allocateCycleCandidates({ bots, auctions: [dear, cheap], nowSec: 2000000000,
    random: () => { throw new Error("A unique minimum must not need randomness"); } });
  const chosen = Object.values(plan.assignments).flatMap(a => [...a.primary, ...a.reserve]);
  assert.deepEqual(chosen.map(a => a.address), [cheap.address]);
  assert.equal(Object.values(plan.assignments).filter(a => !a.primary.length).length, 2);
});

test("every random seed selects only eligible minimum-price ties", () => {
  const bot = { id: "ties", wallet: address(100), strategy: strategy(1), budgetWei: 2000n };
  const auctions = [auction(1), auction(2), { ...auction(3), minimumContribution: "101" },
    { ...auction(4), minimumContribution: "1", manager: bot.wallet }];
  const seen = new Set();
  for (let seed = 0; seed < 100; seed++) {
    const plan = allocateCycleCandidates({ bots: [bot], auctions, nowSec: 2000000000, random: () => seed / 100 });
    const a = plan.assignments.ties;
    assert.equal(a.primary.length, 1);
    assert.equal(a.reserve.length, 1);
    for (const candidate of [...a.primary, ...a.reserve]) assert.equal(candidate.minimumContribution, "100");
    seen.add(a.primary[0].address);
  }
  assert.deepEqual([...seen].sort(), [address(1), address(2)]);
});

test("a formerly expensive auction becomes eligible after the cheapest price rises", () => {
  const bot = { id: "refresh", wallet: address(100), strategy: strategy(1), budgetWei: 2000n };
  const cheap = { ...auction(1), minimumContribution: "50" };
  const other = { ...auction(2), minimumContribution: "60" };
  const pick = auctions => allocateCycleCandidates({ bots: [bot], auctions, nowSec: 2000000000 }).assignments.refresh.primary[0];
  assert.equal(pick([cheap, other]).address, cheap.address);
  assert.equal(pick([{ ...cheap, highestBid: "100", approversCount: 1 }, other]).address, other.address);
});
