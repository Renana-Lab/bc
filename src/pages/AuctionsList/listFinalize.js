import {
  MAX_FINALIZE_ATTEMPTS,
  isNotEndedRevert,
  nextFinalizeAttemptAtMs,
} from "../../real_ethereum/finalizeRetry";

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

// Turns the outcome of one list-page finalize attempt into what to remember and whether to reload.
// Returns { record, refreshList }: record is the session record to store (retryAtMs set only for a
// not-ended outcome with attempts left; chain time endTime + 3 s per attempt), refreshList says the
// auction was finalized and the list must reload. Pass `result` on success or `error` on failure.
export const resolveFinalizeOutcome = ({ result, error, attempts, endTimeMs }) => {
  const notEnded = error ? isNotEndedRevert(error) : result?.reason === "not-ended";
  if (notEnded) {
    return {
      record: {
        attempts,
        retryAtMs:
          attempts < MAX_FINALIZE_ATTEMPTS
            ? nextFinalizeAttemptAtMs(Number(endTimeMs) / 1000, attempts)
            : null,
      },
      refreshList: false,
    };
  }
  return { record: { attempts, retryAtMs: null }, refreshList: !error && Boolean(result?.finalized) };
};
