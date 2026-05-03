import Campaign from "./campaign";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const isAuctionEnded = (endTime) => Number(endTime) * 1000 <= Date.now();

export const shouldFinalizeAuction = async (auction) => {
  const [summary, closed] = await Promise.all([
    auction.methods.getSummary().call(),
    auction.methods.getStatus().call(),
  ]);

  return {
    closed,
    endTime: summary[9],
    hasBids: summary[7] !== ZERO_ADDRESS,
    shouldFinalize: !closed && isAuctionEnded(summary[9]),
  };
};

export const finalizeAuctionIfReady = async (address, from) => {
  if (!address || !from) return false;

  const auction = Campaign(address);
  const { shouldFinalize } = await shouldFinalizeAuction(auction);

  if (!shouldFinalize) return false;

  await auction.methods.finalizeAuctionIfNeeded().send({ from });
  return true;
};
