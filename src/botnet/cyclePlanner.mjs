/* eslint-env es2020 */

const toBigInt = (value, fallback = 0n) => {
  try {
    return typeof value === "bigint" ? value : BigInt(value?.toString?.() || value || "0");
  } catch (_) {
    return fallback;
  }
};

const normalizeAddress = (value) => String(value || "").trim().toLowerCase();

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
  const highestBid = toBigInt(auction.highestBid);
  const myBid = toBigInt(auction.myBid);
  const availableBudget = toBigInt(budget);
  const maxMinimum = toBigInt(strategy.maxMinContributionWei);
  const maxBid = toBigInt(strategy.maxBidWei);
  const outbidBy = toBigInt(strategy.outbidByWei);

  if (minimumContribution > maxMinimum) {
    return { bid: false, reason: "Minimum contribution too high" };
  }

  const emptyAuction = Number(auction.approversCount || 0) === 0 && highestBid === 0n;
  const targetBid = emptyAuction ? minimumContribution : highestBid + outbidBy;
  const incrementalValue = myBid > 0n ? targetBid - myBid : targetBid;

  if (targetBid > maxBid) return { bid: false, reason: "Target bid exceeds max bid" };
  if (incrementalValue <= 0n) {
    return { bid: false, reason: "Existing bid already covers target" };
  }
  if (incrementalValue > availableBudget) {
    return { bid: false, reason: "Insufficient budget" };
  }

  return { bid: true, amountWei: incrementalValue, targetBid };
};

const isStaticallyEligible = (auction, bot, nowSec) => {
  const strategy = bot.strategy || {};
  const wallet = normalizeAddress(bot.wallet);
  const manager = normalizeAddress(auction.manager);
  const highestBidder = normalizeAddress(auction.highestBidder);
  const endTimeSec = Number(auction.endTimeSec || 0);
  const secondsLeft = Math.max(0, endTimeSec - nowSec);
  const minimumContribution = toBigInt(auction.minimumContribution);
  const highestBid = toBigInt(auction.highestBid);
  const targetBid =
    Number(auction.approversCount || 0) === 0 && highestBid === 0n
      ? minimumContribution
      : highestBid + toBigInt(strategy.outbidByWei);

  if (auction.closed || endTimeSec <= nowSec) return false;
  if (wallet && manager === wallet) return false;
  if (strategy.skipIfWinning && wallet && highestBidder === wallet) return false;
  if (secondsLeft < Number(strategy.minTimeRemainingSec || 0)) return false;
  if (minimumContribution > toBigInt(strategy.maxMinContributionWei)) return false;
  if (targetBid > toBigInt(strategy.maxBidWei)) return false;
  return true;
};

const stableAuctionSort = (left, right) => {
  const endDifference = Number(left.endTimeSec || 0) - Number(right.endTimeSec || 0);
  if (endDifference) return endDifference;
  return normalizeAddress(left.address).localeCompare(normalizeAddress(right.address));
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
} = {}) => {
  const orderedAuctions = rotate([...auctions].sort(stableAuctionSort), cursor);
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

      const botAuctions = rotate(orderedAuctions, botIndex + slotIndex);
      let candidate = null;
      for (const auction of botAuctions) {
        const key = normalizeAddress(auction.address);
        candidatesEvaluated += 1;
        if (key && !reserved.has(key) && isStaticallyEligible(auction, bot, nowSec)) {
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
