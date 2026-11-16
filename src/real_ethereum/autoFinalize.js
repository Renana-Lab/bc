import Campaign from "./campaign";
import { chainNowMs } from "./chainClock";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const isAuctionEnded = (endTime) => Number(endTime) * 1000 <= chainNowMs();

export const shouldFinalizeAuction = async (auction) => {
  const [summary, closed] = await Promise.all([
    auction.methods.getSummary().call(),
    auction.methods.getStatus().call(),
  ]);

  return {
    closed,
    ended: isAuctionEnded(summary[8]),
    endTime: summary[8],
    hasBids: summary[6] !== ZERO_ADDRESS,
    shouldFinalize: !closed && isAuctionEnded(summary[8]),
  };
};

// Resolves { finalized, reason } so callers can tell "already closed" from "chain clock says not
// ended yet" (the clock offset can dip between syncs): reason is one of
// "finalized" | "already-closed" | "not-ended" | "missing-args".
export const finalizeAuctionIfReady = async (address, from) => {
  if (!address || !from) return { finalized: false, reason: "missing-args" };

  const auction = Campaign(address);
  const { closed, ended } = await shouldFinalizeAuction(auction);

  if (closed) return { finalized: false, reason: "already-closed" };
  if (!ended) return { finalized: false, reason: "not-ended" };

  await auction.methods.finalizeAuctionIfNeeded().send({ from });
  return { finalized: true, reason: "finalized" };
};
