/* eslint-env es2020 */

const toBigInt = (value, fallback = 0n) => {
  try {
    return typeof value === "bigint" ? value : BigInt(value?.toString?.() || value || "0");
  } catch (_) {
    return fallback;
  }
};

const normalizeAddress = (value) => String(value || "").trim().toLowerCase();

export const getTargetBid = (auction, strategy) =>
  Number(auction.approversCount || 0) === 0 && toBigInt(auction.highestBid) === 0n
    ? toBigInt(auction.minimumContribution)
    : toBigInt(auction.highestBid) + toBigInt(strategy.outbidByWei);

export const clampBidsPerCycle = (value, fallback = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(5, Math.max(1, Math.floor(parsed)));
};

export const getEstimatedWritesPerHour = (intervalSec, bidsPerCycle) => {
  const interval = Math.max(1, Number(intervalSec) || 60);
  return Math.ceil((3600 / interval) * clampBidsPerCycle(bidsPerCycle));
};

export const getActivityUsage = (intervalSec, bidsPerCycle) => {
  const writesPerHour = getEstimatedWritesPerHour(intervalSec, bidsPerCycle);
  if (writesPerHour <= 60) return { level: "low", writesPerHour };
  if (writesPerHour <= 240) return { level: "moderate", writesPerHour };
  return { level: "high", writesPerHour };
};

export const getBidDecision = (auction, budget, strategy) => {
  if (!auction) return { bid: false, reason: "No auction candidate" };
  if (!auction.isActive) return { bid: false, reason: "Auction closed" };
  if (auction.isManager) return { bid: false, reason: "Bot is the seller" };
  if (Number(auction.secondsLeft || 0) < Number(strategy.minTimeRemainingSec || 0)) {
    return { bid: false, reason: "Too little time remaining" };
  }
  if (strategy.skipIfWinning && auction.isWinner) {
    return { bid: false, reason: "Bot already winning" };
  }

  const minimumContribution = toBigInt(auction.minimumContribution);
  const myBid = toBigInt(auction.myBid);
  const availableBudget = toBigInt(budget);
  const maxMinimum = toBigInt(strategy.maxMinContributionWei);
  const maxBid = toBigInt(strategy.maxBidWei);

  if (minimumContribution > maxMinimum) {
    return { bid: false, reason: "Minimum contribution too high" };
  }

  const targetBid = getTargetBid(auction, strategy);
  const incrementalValue = myBid > 0n ? targetBid - myBid : targetBid;
  // The campaign sends only the increment as ETH, but when a previously
  // outbid wallet returns the factory charges its full new cumulative bid
  // from the restored budget. A current winner is charged only the increment.
  const budgetCostWei = auction.isWinner ? incrementalValue : targetBid;

  if (targetBid > maxBid) return { bid: false, reason: "Target bid exceeds max bid" };
  if (incrementalValue <= 0n) {
    return { bid: false, reason: "Existing bid already covers target" };
  }
  if (budgetCostWei > availableBudget) {
    return { bid: false, reason: "Insufficient budget" };
  }

  return { bid: true, amountWei: incrementalValue, targetBid, budgetCostWei };
};

const isStaticallyEligible = (auction, bot, nowSec) => {
  const strategy = bot.strategy || {};
  const wallet = normalizeAddress(bot.wallet);
  const manager = normalizeAddress(auction.manager);
  const highestBidder = normalizeAddress(auction.highestBidder);
  const endTimeSec = Number(auction.endTimeSec || 0);
  const secondsLeft = Math.max(0, endTimeSec - nowSec);
  const minimumContribution = toBigInt(auction.minimumContribution);
  const targetBid = getTargetBid(auction, strategy);

  if (auction.closed || endTimeSec <= nowSec) return false;
  if (wallet && manager === wallet) return false;
  if (strategy.skipIfWinning && wallet && highestBidder === wallet) return false;
  if (secondsLeft < Number(strategy.minTimeRemainingSec || 0)) return false;
  if (minimumContribution > toBigInt(strategy.maxMinContributionWei)) return false;
  if (targetBid > toBigInt(strategy.maxBidWei)) return false;
  const budgetCost = wallet && highestBidder === wallet
    ? targetBid - toBigInt(auction.highestBid)
    : targetBid;
  if (bot.budgetWei !== undefined && budgetCost > toBigInt(bot.budgetWei)) return false;
  return true;
};

const rotate = (values, offset) => {
  if (!values.length) return [];
  const normalized = ((Number(offset) || 0) % values.length + values.length) % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
};

export const allocateCycleCandidates = ({
  bots = [],
  auctions = [],
  cursor = 0,
  nowSec = Math.floor(Date.now() / 1000),
  reservePerSlot = 1,
  random = Math.random,
} = {}) => {
  const orderedAuctions = [...auctions];
  for (let index = orderedAuctions.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [orderedAuctions[index], orderedAuctions[swap]] = [orderedAuctions[swap], orderedAuctions[index]];
  }
  const rankings = new Map();
  const rankFor = (strategy = {}) => {
    const key = String(strategy.outbidByWei || 0);
    if (!rankings.has(key)) {
      rankings.set(key, [...orderedAuctions].sort((left, right) => {
        const a = getTargetBid(left, strategy);
        const b = getTargetBid(right, strategy);
        return a < b ? -1 : a > b ? 1 : 0;
      }));
    }
    return rankings.get(key);
  };
  const orderedBots = rotate(bots, cursor);
  const reserved = new Set();
  const assignments = Object.fromEntries(
    bots.map((bot) => [bot.id, { primary: [], reserve: [] }]),
  );
  let candidatesEvaluated = 0;

  const assignRound = (kind, slotIndex) => {
    for (let botIndex = 0; botIndex < orderedBots.length; botIndex += 1) {
      if (reserved.size >= orderedAuctions.length) break;
      const bot = orderedBots[botIndex];
      const limit = clampBidsPerCycle(bot.strategy?.maxBidsPerCycle);
      if (kind === "primary" && slotIndex >= limit) continue;
      if (kind === "reserve" && slotIndex >= limit * Math.max(0, reservePerSlot)) continue;

      const botAuctions = rankFor(bot.strategy);
      let candidate = null;
      for (const auction of botAuctions) {
        const key = normalizeAddress(auction.address);
        if (!key || reserved.has(key)) continue;
        candidatesEvaluated += 1;
        if (isStaticallyEligible(auction, bot, nowSec)) {
          candidate = auction;
          break;
        }
      }
      if (!candidate) continue;

      reserved.add(normalizeAddress(candidate.address));
      assignments[bot.id][kind].push(candidate);
    }
  };

  const maxBidSlots = bots.reduce(
    (max, bot) => Math.max(max, clampBidsPerCycle(bot.strategy?.maxBidsPerCycle)),
    0,
  );
  for (let slot = 0; slot < maxBidSlots && reserved.size < orderedAuctions.length; slot += 1) {
    assignRound("primary", slot);
  }
  for (let slot = 0; slot < maxBidSlots * Math.max(0, reservePerSlot); slot += 1) {
    if (reserved.size >= orderedAuctions.length) break;
    assignRound("reserve", slot);
  }

  return {
    assignments,
    nextCursor: orderedAuctions.length ? (Number(cursor) + 1) % orderedAuctions.length : 0,
    reservedAuctionCount: reserved.size,
    candidatesEvaluated,
  };
};

export const createEmptyCycleMetrics = (startedAt = Date.now()) => ({
  startedAt,
  durationMs: 0,
  snapshotAgeMs: 0,
  activeAuctions: 0,
  logicalReads: 0,
  rpcBatches: 0,
  candidatesEvaluated: 0,
  bidsAttempted: 0,
  bidsSent: 0,
  cacheHits: 0,
  skippedReason: "",
});

export const finishCycleMetrics = (metrics, patch = {}) => ({
  ...metrics,
  ...patch,
  durationMs: Math.max(0, Date.now() - Number(metrics.startedAt || Date.now())),
});
