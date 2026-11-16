import { readOnlyBatchCall, readOnlyCall } from "../readOnly";
import { getActiveFactoryAddress } from "../marketConfig";

// The closed auctions that concern one participant, read from the same source the auctions list uses (the factory's
// deployed campaigns, then getListSummary / getUserAuctionStatus). Lets the auto-withdraw run without the list page.
// Resolves list-style items for observeAuctions(); THROWS when any read failed, because an incomplete answer must
// not be taken for "no refund pending".
const CHUNK = 15;
const same = (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase();

const batched = async (items, createCalls, options) => {
  const values = [];
  for (let start = 0; start < items.length; start += CHUNK) {
    const slice = items.slice(start, start + CHUNK);
    const results = await readOnlyBatchCall(({ campaign }) => slice.map((item) => createCalls(campaign, item)), undefined, options);
    results.forEach((result) => {
      if (result.status !== "fulfilled") throw new Error("Auction read failed.");
      values.push(result.value);
    });
  }
  return values;
};

export const loadParticipantAuctions = async ({ account, factoryAddress = getActiveFactoryAddress() }) => {
  if (!account) return [];
  const options = { factoryAddress };
  const addresses = await readOnlyCall(({ factory }) => factory.methods.getDeployedCampaigns(), undefined, options);
  const summaries = await batched(addresses, (campaign, address) => campaign(address).methods.getListSummary(), options);
  const closed = addresses
    .map((address, index) => ({ address, summary: summaries[index] }))
    .filter(({ summary }) => Boolean(summary[8]));
  const statuses = await batched(closed, (campaign, { address }) => campaign(address).methods.getUserAuctionStatus(account), options);
  return closed
    .map(({ address, summary }, index) => ({
      address, closed: true, manager: summary[3], highestBidder: summary[6],
      addresses: statuses[index][0] ? [account] : [], isRefunded: Boolean(statuses[index][2]),
    }))
    .filter((auction) => same(auction.manager, account) || auction.addresses.length > 0 || same(auction.highestBidder, account));
};
