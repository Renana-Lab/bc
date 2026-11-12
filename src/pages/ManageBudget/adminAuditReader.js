// Network readers behind the Admin Zone cards. Kept out of the React file so they can be unit-tested
// and so the Users and Audit cards share one audit read.
import CampaignFactory from "../../real_ethereum/build/CampaignFactory.json";
import Campaign from "../../real_ethereum/build/Campaign.json";
import { readOnlyExecute } from "../../real_ethereum/readOnly";
import { isRpcProviderFailure } from "../../real_ethereum/rpcConfig";
import { getActiveAuctionSnapshot } from "../../real_ethereum/activeAuctionRegistry";
import { readLogsChunked } from "../../real_ethereum/chunkedLogs";
import { mergeAuditEvents, normalizeAuditEvent } from "./adminCardData";

export const DEFAULT_AUDIT_LOOKBACK_BLOCKS = 1000;
export const MAX_AUDIT_LOOKBACK_BLOCKS = 100000;
export const AUDIT_MAX_REQUESTS = 60;
export const AUDIT_CAMPAIGN_LIMIT = 25;
export const USER_READ_CHUNK = 10;
export const USER_READ_CAP = 500;
export const AUDIT_CACHE_TTL_MS = 10000;
const FORCE_MIN_INTERVAL_MS = 3000;
const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };

export const getAuditLookbackBlocks = (raw = process.env.REACT_APP_ADMIN_AUDIT_LOOKBACK_BLOCKS) => {
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_AUDIT_LOOKBACK_BLOCKS)
    : DEFAULT_AUDIT_LOOKBACK_BLOCKS;
};

const eventItems = (abi, names) => names.map((name) => abi.find((item) => item.type === "event" && item.name === name));

// Decode raw logs with the given ABI event items. Unknown topics are skipped.
export const decodeLogs = (web3, items, logs) => {
  const byTopic = new Map(items.map((item) => [web3.eth.abi.encodeEventSignature(item), item]));
  return logs
    .map((log) => {
      const item = byTopic.get(log.topics?.[0]);
      if (!item) return null;
      try {
        return {
          event: item.name,
          address: log.address,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.logIndex),
          transactionHash: log.transactionHash,
          returnValues: web3.eth.abi.decodeLog(item.inputs, log.data, log.topics.slice(1)),
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
};

const FACTORY_EVENTS = ["BudgetChanged", "AuctionCreatedDetailed", "AuctionFinalizationFailed"];
const CAMPAIGN_EVENTS = ["SellerPaid", "RefundProcessed"];

const recentCampaignAddresses = (createdEvents, factoryAddress) => {
  const addresses = createdEvents.map((event) => event.auction).filter(Boolean);
  try {
    const snapshot = getActiveAuctionSnapshot(factoryAddress);
    [...(snapshot?.activeAuctions || []), ...(snapshot?.finalizableAuctions || [])].forEach((auction) => {
      if (auction?.address) addresses.push(String(auction.address).toLowerCase());
    });
  } catch (_) {}
  return Array.from(new Set(addresses)).slice(-AUDIT_CAMPAIGN_LIMIT);
};

// One audit read: factory events in chunked getLogs calls (one call per chunk for all three topics),
// then SellerPaid/RefundProcessed for all recent campaigns in ONE chunked getLogs with address: [campaigns].
export const readAuditEvents = async (factoryAddress, { lookback = getAuditLookbackBlocks() } = {}) => {
  const options = { ...READ_OPTIONS, factoryAddress };
  const latest = Number(await readOnlyExecute(({ web3 }) => web3.eth.getBlockNumber(), undefined, options));
  const fromBlock = Math.max(0, latest - lookback + 1);

  const factoryItems = eventItems(CampaignFactory.abi, FACTORY_EVENTS);
  const campaignItems = eventItems(Campaign.abi, CAMPAIGN_EVENTS);
  const topicsFor = (web3, items) => [items.map((item) => web3.eth.abi.encodeEventSignature(item))];

  const factoryRead = await readLogsChunked({
    fromBlock,
    toBlock: latest,
    maxRequests: AUDIT_MAX_REQUESTS,
    fetchRange: (from, to) =>
      readOnlyExecute(
        async ({ web3 }) =>
          decodeLogs(
            web3,
            factoryItems,
            await web3.eth.getPastLogs({
              address: factoryAddress,
              topics: topicsFor(web3, factoryItems),
              fromBlock: from,
              toBlock: to,
            })
          ),
        undefined,
        options
      ),
  });
  const factoryEvents = factoryRead.logs.map((event) => normalizeAuditEvent(event, "factory"));

  const campaigns = recentCampaignAddresses(
    factoryEvents.filter((event) => event.name === "AuctionCreatedDetailed"),
    factoryAddress
  );
  let campaignRead = { logs: [], totalRanges: 0, failedRanges: [], truncated: false, fromBlock };
  if (campaigns.length) {
    campaignRead = await readLogsChunked({
      fromBlock,
      toBlock: latest,
      maxRequests: AUDIT_MAX_REQUESTS,
      fetchRange: (from, to) =>
        readOnlyExecute(
          async ({ web3 }) =>
            decodeLogs(
              web3,
              campaignItems,
              await web3.eth.getPastLogs({
                address: campaigns,
                topics: topicsFor(web3, campaignItems),
                fromBlock: from,
                toBlock: to,
              })
            ),
          undefined,
          options
        ),
    });
  }
  const campaignEvents = campaignRead.logs.map((event) => normalizeAuditEvent(event, "campaign"));

  const strip = ({ logs, ...rest }) => rest;
  return {
    latest,
    fromBlock: factoryRead.fromBlock,
    lookback,
    campaignCount: campaigns.length,
    events: mergeAuditEvents(factoryEvents, campaignEvents),
    factory: strip(factoryRead),
    campaigns: strip(campaignRead),
    totalRanges: factoryRead.totalRanges + campaignRead.totalRanges,
    failedRanges: [...factoryRead.failedRanges, ...campaignRead.failedRanges],
    truncated: factoryRead.truncated || campaignRead.truncated,
    readAt: Date.now(),
  };
};

// ---- shared, short-TTL cache so the Users and Audit cards do one read between them -----------

const auditCache = new Map();

export const resetAuditCache = () => auditCache.clear();

export const getAuditSnapshot = (factoryAddress, { force = false, reader = readAuditEvents, now = Date.now } = {}) => {
  const key = String(factoryAddress || "").toLowerCase();
  const entry = auditCache.get(key);
  if (entry?.promise) return entry.promise;
  const age = entry ? now() - entry.at : Infinity;
  if (entry?.value && age < (force ? FORCE_MIN_INTERVAL_MS : AUDIT_CACHE_TTL_MS)) return Promise.resolve(entry.value);

  const promise = reader(factoryAddress)
    .then((value) => {
      auditCache.set(key, { at: now(), value });
      return value;
    })
    .catch((error) => {
      auditCache.delete(key); // failures are never cached
      throw error;
    });
  auditCache.set(key, { at: entry?.at || 0, value: entry?.value, promise });
  return promise;
};

// ---- allUsers --------------------------------------------------------------------------------

// allUsers is a public array with no length getter. readIndex(i) resolves to an address or throws.
// A contract revert (index out of range) means "end of list"; an RPC failure is NOT the end: the list
// stops there with an error so the UI can warn instead of silently truncating.
export const readAllUsers = async (
  readIndex,
  { chunk = USER_READ_CHUNK, cap = USER_READ_CAP, isRpcError = isRpcProviderFailure } = {}
) => {
  const addresses = [];
  for (let start = 0; start < cap; start += chunk) {
    const size = Math.min(chunk, cap - start);
    const results = await Promise.all(
      Array.from({ length: size }, (_, offset) =>
        readIndex(start + offset).then(
          (value) => ({ value }),
          (error) => ({ error })
        )
      )
    );
    for (let offset = 0; offset < results.length; offset += 1) {
      const { value, error } = results[offset];
      if (error) {
        if (isRpcError(error)) {
          return {
            addresses,
            complete: false,
            warning: `RPC error while reading user #${start + offset}: the list may be incomplete (${error.message || error}).`,
          };
        }
        return { addresses, complete: true, warning: "" }; // reverted: end of list
      }
      addresses.push(value);
    }
  }
  return { addresses, complete: false, warning: `Stopped at the ${cap}-user read cap: the list may be incomplete.` };
};
