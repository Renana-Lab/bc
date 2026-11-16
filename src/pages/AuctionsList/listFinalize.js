import { MAX_FINALIZE_ATTEMPTS } from "../../real_ethereum/finalizeRetry";

const same = (left, right) =>
  Boolean(left && right) && String(left).toLowerCase() === String(right).toLowerCase();

export const isParticipant = (auction, account) =>
  same(auction.manager, account) ||
  same(auction.highestBidder, account) ||
  Boolean(auction.addresses?.some((address) => same(address, account)));

// Decides which single auction (if any) the list should finalize next.
// records: Map<lowercase address, { attempts, retryAtMs }>. A record without retryAtMs is final
// (done or out of attempts). Returns null while a finalize is in flight, so at most one runs at a time.
export const pickAuctionToFinalize = ({ auctions, account, nowMs, records, inFlight }) => {
  if (inFlight || !account) return null;
  return (
    auctions.find((auction) => {
      if (auction.isReadPlaceholder || auction.closed) return false;
      const endTime = Number(auction.endTime);
      if (!(endTime > 0) || endTime > nowMs) return false;
      if (!isParticipant(auction, account)) return false;
      const record = records.get(String(auction.address).toLowerCase());
      if (!record) return true;
      return (
        record.retryAtMs != null &&
        record.attempts < MAX_FINALIZE_ATTEMPTS &&
        nowMs >= record.retryAtMs
      );
    }) || null
  );
};
