import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTOR_RUN_MS,
  AUCTION_SPECS,
  assignExperimentRoles,
  buildHumanSchedule,
} from "./experimentCore.mjs";
import { allocateCycleCandidates, getBidDecision } from "../botnet/cyclePlanner.mjs";

const wallets = Array.from({ length: 50 }, (_value, index) => ({
  number: index + 1,
  address: `0x${String(index + 1).padStart(40, "0")}`,
  privateKey: `0x${String(index + 1).padStart(64, "0")}`,
}));

const strategyFor = (actor, willingnessWei = 2000) => ({
  maxMinContributionWei: willingnessWei,
  maxBidWei: willingnessWei,
  outbidByWei: 10,
  minTimeRemainingSec: 20,
  skipIfWinning: true,
  maxBidsPerCycle: 1,
});

const runSimulation = (seed) => {
  const assigned = assignExperimentRoles(wallets, { experimentId: "EXP-STRESS", seed });
  const sellers = assigned.participants.filter((row) => row.role === "seller");
  const humans = assigned.participants.filter((row) => row.role === "synthetic-human");
  const bots = assigned.participants.filter((row) => row.role === "standard-bot");
  const startAtMs = 1_000_000;
  const stopAtMs = startAtMs + ACTOR_RUN_MS;
  const endTimeSec = Math.floor((startAtMs + 25 * 60 * 1000) / 1000);
  const budgets = new Map([...humans, ...bots].map((actor) => [actor.address, 2000n]));
  const schedules = new Map(humans.map((actor) => [actor.actorId, buildHumanSchedule(actor, { seed, startAtMs, stopAtMs })]));
  const auctions = AUCTION_SPECS.map((spec, index) => ({
    ...spec,
    minimumContribution: spec.minimumBidWei,
    address: `0x${String(100 + index).padStart(40, "0")}`,
    manager: sellers[index].address,
    highestBid: "0",
    highestBidder: "0x0000000000000000000000000000000000000000",
    approversCount: 0,
    endTimeSec,
    closed: false,
    bids: new Map(),
  }));
  const seenSellerBids = [];
  const duplicateBotAssignments = [];
  let cursor = 0;
  let bidCount = 0;

  const attempt = (actor, auction, strategy, atMs) => {
    if (atMs >= stopAtMs) throw new Error("Work executed after stop boundary");
    if (actor.address === auction.manager) seenSellerBids.push(actor.address);
    const myBid = auction.bids.get(actor.address) || 0n;
    const decision = getBidDecision({
      ...auction,
      isActive: atMs < auction.endTimeSec * 1000,
      secondsLeft: Math.floor((auction.endTimeSec * 1000 - atMs) / 1000),
      isManager: actor.address === auction.manager,
      isWinner: actor.address === auction.highestBidder,
      myBid,
    }, budgets.get(actor.address), strategy);
    if (!decision.bid) return;
    const previousWinner = auction.highestBidder;
    const previousHighest = BigInt(auction.highestBid);
    if (previousWinner !== "0x0000000000000000000000000000000000000000" && previousWinner !== actor.address) {
      budgets.set(previousWinner, budgets.get(previousWinner) + previousHighest);
    }
    budgets.set(actor.address, budgets.get(actor.address) - decision.budgetCostWei);
    assert.ok(budgets.get(actor.address) >= 0n);
    auction.bids.set(actor.address, decision.targetBid);
    auction.highestBid = decision.targetBid.toString();
    auction.highestBidder = actor.address;
    auction.approversCount = auction.bids.size;
    bidCount += 1;
  };

  for (let elapsedSeconds = 0; elapsedSeconds < 1200; elapsedSeconds += 1) {
    const nowMs = startAtMs + elapsedSeconds * 1000;
    humans.forEach((actor) => {
      schedules.get(actor.actorId)
        .filter((step) => step.atMs >= nowMs && step.atMs < nowMs + 1000)
        .forEach((step) => attempt(actor, auctions.find((auction) => auction.id === step.auctionId), strategyFor(actor, step.willingnessWei), step.atMs));
    });
    if (elapsedSeconds % 60 === 0) {
      const allocation = allocateCycleCandidates({
        bots: bots.map((actor) => ({ id: actor.actorId, wallet: actor.address, strategy: strategyFor(actor) })),
        auctions,
        cursor,
        nowSec: Math.floor(nowMs / 1000),
      });
      cursor = allocation.nextCursor;
      const roundAddresses = [];
      bots.forEach((actor) => {
        const auction = allocation.assignments[actor.actorId].primary[0];
        if (!auction) return;
        if (roundAddresses.includes(auction.address)) duplicateBotAssignments.push(auction.address);
        roundAddresses.push(auction.address);
        attempt(actor, auction, strategyFor(actor), nowMs);
      });
    }
  }

  return { bidCount, budgets, seenSellerBids, duplicateBotAssignments, humans };
};

test("30 actors share 10 auctions without role, nonce-planning, budget, or stop violations", () => {
  for (let index = 0; index < 25; index += 1) {
    const result = runSimulation(`simulation-${index}`);
    assert.ok(result.bidCount > 0);
    assert.deepEqual(result.seenSellerBids, []);
    assert.deepEqual(result.duplicateBotAssignments, []);
    assert.ok([...result.budgets.values()].every((budget) => budget >= 0n && budget <= 2000n));
    assert.equal(result.humans.filter((actor) => actor.observer).length, 2);
  }
});
