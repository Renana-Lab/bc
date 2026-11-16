import { readOnlyBatchCall, readOnlyCall } from "../readOnly";
import { getActiveFactoryAddress } from "../marketConfig";

// The closed auctions that concern one participant, read from the same source the auctions list uses (the factory's
// deployed campaigns, then getListSummary / getUserAuctionStatus). Lets the auto-withdraw run without the list page.
//
// A failed read is never taken for "nothing due". Each failing address is retried (3 attempts, ~2 s backoff), then read
// directly with getUserAuctionStatus; an address that still cannot be resolved, or that the participant might have funds
// in, is returned as a `probe` entry, so the auto-withdraw reads it on chain and holds the sweep back while it cannot.
// Only a failure to list the auctions at all rejects. Closed auctions found to concern the participant not at all are
// remembered, so later signatures do not read them again.
const CHUNK = 15;
const ATTEMPTS = 3;
const BACKOFF_MS = 2000;
const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: true };
const same = (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checkedNothingDue = new Set(); // `${factory}:${account}:${address}` of closed auctions that do not concern the account
export const __resetParticipantAuctionsForTests = () => checkedNothingDue.clear();

// Reads one call per item in chunks; items whose call failed are retried. Returns Map(item -> value) for the ones that
// finally succeeded (the rest are absent).
const readEach = async (items, createCall, { options, sleep }) => {
  const values = new Map();
  let pending = items;
  for (let attempt = 0; attempt < ATTEMPTS && pending.length; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS * attempt);
    const failed = [];
    for (let start = 0; start < pending.length; start += CHUNK) {
      const slice = pending.slice(start, start + CHUNK);
      let results;
      try {
        results = await readOnlyBatchCall(({ campaign }) => slice.map((item) => createCall(campaign, item)), undefined, options);
      } catch {
        failed.push(...slice);
        continue;
      }
      results.forEach((result, index) => {
        if (result?.status === "fulfilled") values.set(slice[index], result.value);
        else failed.push(slice[index]);
      });
    }
    pending = failed;
  }
  return values;
};

const listAddresses = async ({ options, sleep }) => {
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS * attempt);
    try { return await readOnlyCall(({ factory }) => factory.methods.getDeployedCampaigns(), undefined, options); } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Auction list read failed.");
};

export const loadParticipantAuctions = async ({ account, factoryAddress = getActiveFactoryAddress(), sleep = defaultSleep }) => {
  if (!account) return [];
  const options = { factoryAddress, ...READ_OPTIONS };
  const keyOf = (address) => `${String(factoryAddress).toLowerCase()}:${String(account).toLowerCase()}:${String(address).toLowerCase()}`;
  const addresses = (await listAddresses({ options, sleep })).filter((address) => !checkedNothingDue.has(keyOf(address)));

  const summaries = await readEach(addresses, (campaign, address) => campaign(address).methods.getListSummary(), { options, sleep });
  const closed = addresses.filter((address) => summaries.has(address) && Boolean(summaries.get(address)[8]));
  const unresolved = addresses.filter((address) => !summaries.has(address)); // closed state unknown

  const statuses = await readEach([...closed, ...unresolved], (campaign, address) => campaign(address).methods.getUserAuctionStatus(account), { options, sleep });
  // Last resort for an address whose batched reads kept failing: one direct read of the participant's own status.
  for (const address of [...closed, ...unresolved]) {
    if (statuses.has(address)) continue;
    try { statuses.set(address, await readOnlyCall(({ campaign }) => campaign(address).methods.getUserAuctionStatus(account), undefined, options)); } catch { /* stays unknown */ }
  }

  const items = [];
  for (const address of closed) {
    const summary = summaries.get(address);
    const status = statuses.get(address);
    if (!status) { items.push({ address, closed: true, probe: true }); continue; } // cannot tell: the withdraw code checks it
    const item = {
      address, closed: true, manager: summary[3], highestBidder: summary[6],
      addresses: status[0] ? [account] : [], isRefunded: Boolean(status[2]),
    };
    if (same(item.manager, account) || item.addresses.length || same(item.highestBidder, account)) items.push(item);
    else checkedNothingDue.add(keyOf(address)); // closed is final: nothing here will ever be due
  }
  for (const address of unresolved) {
    const status = statuses.get(address);
    // Without the summary we do not know if it is closed. Not involved at all (no bid, not the seller): nothing to hold back.
    if (status && !status[0] && !status[3]) continue;
    items.push({ address, closed: true, probe: true });
  }
  return items;
};
