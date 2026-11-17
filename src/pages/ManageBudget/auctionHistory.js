// Per-auction history rebuilt from chain events: bids, budget ledger and admin audit trail.
// Nothing here ever reads an auction payload (it is winner-only); events carry no payloads either.
import { describeRangeHealth, readLogsChunked } from "../../real_ethereum/chunkedLogs";
import { getAuditLookbackBlocks } from "./adminAuditReader";
import { normalizeAuditEvent } from "./adminCardData";

export const RECORD_CAMPAIGN_EVENTS = ["BidRecorded", "RefundProcessed", "SellerPaid", "SellerPaymentDeferred"];
export const RECORD_FACTORY_EVENTS = [
  "AuctionCreatedDetailed",
  "BudgetChanged",
  "UserBudgetSet",
  "MinimumChanged",
  "AuctionClosedEarly",
  "AuctionCancelled",
  "AuctionHiddenChanged",
];
export const AUDIT_TRAIL_EVENTS = ["MinimumChanged", "AuctionClosedEarly", "AuctionCancelled", "AuctionHiddenChanged"];
const MAX_REQUESTS = 60;

const lower = (value) => String(value ?? "").toLowerCase();
const chronological = (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

// reader: { getLatestBlock(), readLogs({ address, kind, names, from, to }) }
export const readNormalizedEvents = async ({ reader, kind, address, names, fromBlock, toBlock, maxRequests = MAX_REQUESTS }) => {
  const read = await readLogsChunked({
    fromBlock,
    toBlock,
    maxRequests,
    fetchRange: (from, to) => reader.readLogs({ address, kind, names, from, to }),
  });
  const { logs, ...health } = read;
  return { events: logs.map((log) => normalizeAuditEvent(log, kind)), health };
};

export const mergeHealth = (...healths) => ({
  totalRanges: healths.reduce((sum, h) => sum + (h.totalRanges || 0), 0),
  failedRanges: healths.flatMap((h) => h.failedRanges || []),
  truncated: healths.some((h) => h.truncated),
  fromBlock: Math.max(...healths.map((h) => h.fromBlock || 0)),
});

export const buildBidRows = (campaignEvents = []) =>
  campaignEvents
    .filter((event) => event.name === "BidRecorded")
    .sort(chronological)
    .map((event) => ({
      id: event.id,
      bidder: event.args.bidder,
      amount: event.args.amount,
      cumulative: event.args.cumulativeBid,
      budgetBefore: event.args.budgetBefore,
      budgetAfter: event.args.budgetAfter,
      timeSec: Number(event.args.time) || 0,
      blockNumber: event.blockNumber,
    }));

export const buildLedgerRows = ({ campaign, bidRows = [], factoryEvents = [], campaignEvents = [] }) => {
  const key = lower(campaign);
  const bidders = new Set(bidRows.map((row) => lower(row.bidder)));
  const fromFactory = factoryEvents.filter((event) => {
    if (event.name === "BudgetChanged") return lower(event.args.campaignAddress) === key || bidders.has(lower(event.args.user));
    if (event.name === "UserBudgetSet") return bidders.has(lower(event.args.user));
    return false;
  });
  const fromCampaign = campaignEvents.filter((event) => ["RefundProcessed", "SellerPaid", "SellerPaymentDeferred"].includes(event.name));
  return [...fromFactory, ...fromCampaign].sort(chronological).map((event) => ({
    id: event.id,
    type: event.name,
    who: event.actor,
    detail: event.summary,
    blockNumber: event.blockNumber,
  }));
};

export const buildAuditRows = ({ campaign, factoryEvents = [] }) => {
  const key = lower(campaign);
  return factoryEvents
    .filter((event) => AUDIT_TRAIL_EVENTS.includes(event.name) && lower(event.args.campaign) === key)
    .sort(chronological)
    .map((event) => ({ id: event.id, type: event.name, actor: event.args.by, detail: event.summary, blockNumber: event.blockNumber }));
};

// The original minimum: the AuctionCreatedDetailed value when it is in range, else the oldest MinimumChanged "old" value.
export const findOriginalMinimum = ({ campaign, factoryEvents = [] }) => {
  const key = lower(campaign);
  const created = factoryEvents.find((event) => event.name === "AuctionCreatedDetailed" && lower(event.args.campaignAddress) === key);
  if (created) return created.args.minimum;
  const changes = factoryEvents
    .filter((event) => event.name === "MinimumChanged" && lower(event.args.campaign) === key)
    .sort(chronological);
  return changes.length ? changes[0].args.oldMinimum : "";
};

export const readAuctionHistory = async ({ campaign, factoryAddress, reader, lookback = getAuditLookbackBlocks() }) => {
  const latest = await reader.getLatestBlock();
  const fromBlock = Math.max(0, latest - lookback + 1);
  const [campaignRead, factoryRead] = await Promise.all([
    readNormalizedEvents({ reader, kind: "campaign", address: campaign, names: RECORD_CAMPAIGN_EVENTS, fromBlock, toBlock: latest }),
    readNormalizedEvents({ reader, kind: "factory", address: factoryAddress, names: RECORD_FACTORY_EVENTS, fromBlock, toBlock: latest }),
  ]);
  const bids = buildBidRows(campaignRead.events);
  const health = mergeHealth(campaignRead.health, factoryRead.health);
  return {
    bids,
    ledger: buildLedgerRows({ campaign, bidRows: bids, factoryEvents: factoryRead.events, campaignEvents: campaignRead.events }),
    audit: buildAuditRows({ campaign, factoryEvents: factoryRead.events }),
    originalMinimum: findOriginalMinimum({ campaign, factoryEvents: factoryRead.events }),
    health,
    healthNote: describeRangeHealth(health),
    lookback,
    fromBlock: health.fromBlock,
    latest,
  };
};
