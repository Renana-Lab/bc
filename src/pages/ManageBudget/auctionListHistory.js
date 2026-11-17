// "Auction list history": which auctions were active at a chosen time, with their highest bid then, rebuilt from
// chain events (AuctionCreatedDetailed, BidRecorded, AuctionClosedEarly, AuctionCancelled), never from the browser's
// own registry. Block numbers stand in for time on events that carry no timestamp, so the chosen time is first
// mapped to the last block at or before it.
import { describeRangeHealth } from "../../real_ethereum/chunkedLogs";
import { getAuditLookbackBlocks } from "./adminAuditReader";
import { mergeHealth, readNormalizedEvents } from "./auctionHistory";

const FACTORY_EVENTS = ["AuctionCreatedDetailed", "AuctionClosedEarly", "AuctionCancelled"];
const lower = (value) => String(value ?? "").toLowerCase();

// Largest block in [from, latest] whose timestamp is <= atSec, or null when even `from` is later.
export const findBlockAtOrBefore = async ({ atSec, from, latest, getBlockTimestamp }) => {
  if ((await getBlockTimestamp(from)) > atSec) return null;
  if ((await getBlockTimestamp(latest)) <= atSec) return latest;
  let low = from; // timestamp(low) <= atSec
  let high = latest; // timestamp(high) > atSec
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if ((await getBlockTimestamp(mid)) <= atSec) low = mid;
    else high = mid;
  }
  return low;
};

// Pure: events (normalized) + the block at the chosen time -> rows.
export const buildListState = ({ atSec, blockAtT, factoryEvents = [], bidEvents = [] }) => {
  if (blockAtT === null) return [];
  const before = (event) => event.blockNumber <= blockAtT;
  const ended = new Set(
    factoryEvents
      .filter((event) => ["AuctionClosedEarly", "AuctionCancelled"].includes(event.name) && before(event))
      .map((event) => lower(event.args.campaign))
  );
  const rows = factoryEvents
    .filter((event) => event.name === "AuctionCreatedDetailed" && before(event))
    .filter((event) => Number(event.args.endTime) > atSec && !ended.has(lower(event.args.campaignAddress)))
    .map((event) => ({
      address: lower(event.args.campaignAddress),
      description: event.args.dataDescription,
      endTimeSec: Number(event.args.endTime),
      minimum: event.args.minimum,
      highestBid: "0",
      createdBlock: event.blockNumber,
    }));
  const byAddress = new Map(rows.map((row) => [row.address, row]));
  bidEvents
    .filter((event) => event.name === "BidRecorded" && Number(event.args.time) <= atSec)
    .forEach((event) => {
      const row = byAddress.get(lower(event.contract));
      if (row && BigInt(event.args.cumulativeBid) > BigInt(row.highestBid)) row.highestBid = event.args.cumulativeBid;
    });
  return rows.sort((a, b) => a.endTimeSec - b.endTimeSec);
};

export const readAuctionListState = async ({ atSec, factoryAddress, reader, lookback = getAuditLookbackBlocks() }) => {
  const latest = await reader.getLatestBlock();
  const from = Math.max(0, latest - lookback + 1);
  const blockAtT = await findBlockAtOrBefore({ atSec, from, latest, getBlockTimestamp: reader.getBlockTimestamp });
  if (blockAtT === null) {
    return { rows: [], blockAtT, outOfRange: true, healthNote: "", from, latest, lookback };
  }
  const factoryRead = await readNormalizedEvents({
    reader, kind: "factory", address: factoryAddress, names: FACTORY_EVENTS, fromBlock: from, toBlock: blockAtT,
  });
  const created = factoryRead.events.filter((event) => event.name === "AuctionCreatedDetailed");
  const candidates = created.map((event) => lower(event.args.campaignAddress));
  const bidRead = candidates.length
    ? await readNormalizedEvents({ reader, kind: "campaign", address: candidates, names: ["BidRecorded"], fromBlock: from, toBlock: blockAtT })
    : { events: [], health: { totalRanges: 0, failedRanges: [], truncated: false, fromBlock: from } };
  const health = mergeHealth(factoryRead.health, bidRead.health);
  return {
    rows: buildListState({ atSec, blockAtT, factoryEvents: factoryRead.events, bidEvents: bidRead.events }),
    blockAtT,
    outOfRange: false,
    healthNote: describeRangeHealth(health),
    from,
    latest,
    lookback,
  };
};
