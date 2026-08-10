import { readOnlyBatchCall, readOnlyCall } from "./readOnly";
import { getActiveFactoryAddress } from "./marketConfig";

const STORAGE_PREFIX = "data-market:active-auctions:v1";
const SNAPSHOT_TTL_MS = Math.max(
  5000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_TTL_MS || 15000),
);
const STORED_MAX_AGE_MS = 10 * 60 * 1000;
const DEPLOYED_ADDRESSES_TTL_MS = Math.max(
  10000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_DISCOVERY_TTL_MS || 15000),
);
const DISCOVERY_WINDOW = Math.max(
  20,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_DISCOVERY_WINDOW || 80),
);
const READ_BATCH_SIZE = Math.max(
  5,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_BATCH_SIZE || 15),
);

const snapshots = new Map();
const refreshes = new Map();
const deployedAddresses = new Map();

const normalizeAddress = (value) => String(value || "").trim().toLowerCase();
const storageKey = (factoryAddress) =>
  `${STORAGE_PREFIX}:${normalizeAddress(factoryAddress)}`;

const normalizeAuction = (auction = {}) => ({
  address: String(auction.address || ""),
  minimumContribution: String(auction.minimumContribution || "0"),
  approversCount: Number(auction.approversCount || 0),
  manager: String(auction.manager || ""),
  highestBid: String(auction.highestBid || "0"),
  highestBidder: String(auction.highestBidder || ""),
  endTimeSec: Number(
    auction.endTimeSec ||
      (Number(auction.endTime || 0) > 100000000000
        ? Number(auction.endTime) / 1000
        : Number(auction.endTime || 0)),
  ),
  closed: Boolean(auction.closed),
});

const trimSnapshot = (snapshot, nowSec = Math.floor(Date.now() / 1000)) => ({
  ...snapshot,
  activeAuctions: (snapshot.activeAuctions || [])
    .map(normalizeAuction)
    .filter(
      (auction) =>
        auction.address && !auction.closed && auction.endTimeSec > nowSec,
    )
    .sort((a, b) => a.endTimeSec - b.endTimeSec),
  finalizableAuctions: (snapshot.finalizableAuctions || [])
    .map(normalizeAuction)
    .filter(
      (auction) =>
        auction.address &&
        !auction.closed &&
        auction.endTimeSec <= nowSec &&
        auction.approversCount > 0,
    )
    .slice(0, 20),
});

const readStoredSnapshot = (factoryAddress) => {
  if (typeof window === "undefined" || !window.localStorage) return null;

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(storageKey(factoryAddress)) || "null",
    );
    if (
      !stored ||
      normalizeAddress(stored.factoryAddress) !== normalizeAddress(factoryAddress) ||
      Date.now() - Number(stored.updatedAt || 0) > STORED_MAX_AGE_MS
    ) {
      return null;
    }
    return trimSnapshot(stored);
  } catch (_) {
    return null;
  }
};

const saveSnapshot = (snapshot) => {
  const normalized = trimSnapshot(snapshot);
  const factoryKey = normalizeAddress(normalized.factoryAddress);
  snapshots.set(factoryKey, normalized);

  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(storageKey(factoryKey), JSON.stringify(normalized));
    } catch (_) {
      // The in-memory registry remains available when browser storage is full.
    }
  }

  return normalized;
};

const getCachedSnapshot = (factoryAddress) => {
  const factoryKey = normalizeAddress(factoryAddress);
  if (!factoryKey) return null;

  const memory = snapshots.get(factoryKey);
  if (memory) return trimSnapshot(memory);

  const stored = readStoredSnapshot(factoryKey);
  if (stored) snapshots.set(factoryKey, stored);
  return stored;
};

const mergeAuctions = (...groups) => {
  const byAddress = new Map();
  groups.flat().forEach((auction) => {
    const normalized = normalizeAuction(auction);
    const key = normalizeAddress(normalized.address);
    if (key) byAddress.set(key, normalized);
  });
  return [...byAddress.values()];
};

export const publishActiveAuctions = (
  factoryAddress = getActiveFactoryAddress(),
  auctions = [],
  source = "website",
) => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const existing = getCachedSnapshot(factoryAddress);
  const merged = mergeAuctions(existing?.activeAuctions || [], auctions);

  return saveSnapshot({
    factoryAddress,
    updatedAt: now,
    expiresAt: now + SNAPSHOT_TTL_MS,
    source,
    activeAuctions: merged.filter(
      (auction) => !auction.closed && auction.endTimeSec > nowSec,
    ),
    finalizableAuctions: mergeAuctions(
      existing?.finalizableAuctions || [],
      auctions,
    ).filter(
      (auction) =>
        !auction.closed &&
        auction.endTimeSec <= nowSec &&
        auction.approversCount > 0,
    ),
  });
};

const getDeployedAddresses = async (factoryAddress, force = false) => {
  const key = normalizeAddress(factoryAddress);
  const cached = deployedAddresses.get(key);
  if (!force && cached && Date.now() - cached.updatedAt < DEPLOYED_ADDRESSES_TTL_MS) {
    return cached.addresses;
  }

  const addresses = await readOnlyCall(
    ({ factory }) => factory.methods.getDeployedCampaigns(),
    undefined,
    {
      factoryAddress,
      preferInjected: true,
      allowInjectedFallback: true,
    },
  );
  deployedAddresses.set(key, { addresses, updatedAt: Date.now() });
  return addresses;
};

const readAuctionSummaries = async (addresses, factoryAddress) => {
  const auctions = [];

  for (let offset = 0; offset < addresses.length; offset += READ_BATCH_SIZE) {
    const chunk = addresses.slice(offset, offset + READ_BATCH_SIZE);
    const results = await readOnlyBatchCall(
      ({ campaign }) =>
        chunk.map((address) => campaign(address).methods.getListSummary()),
      undefined,
      {
        factoryAddress,
        preferInjected: true,
        allowInjectedFallback: true,
      },
    );

    results.forEach((result, index) => {
      if (result?.status !== "fulfilled") return;
      const details = result.value;
      auctions.push(
        normalizeAuction({
          address: chunk[index],
          minimumContribution: details[0],
          approversCount: details[2],
          manager: details[3],
          highestBid: details[4],
          highestBidder: details[6],
          endTimeSec: details[7],
          closed: details[8],
        }),
      );
    });
  }

  return auctions;
};

export const refreshActiveAuctionRegistry = async (
  factoryAddress = getActiveFactoryAddress(),
  { force = false } = {},
) => {
  const factoryKey = normalizeAddress(factoryAddress);
  if (!factoryKey) throw new Error("No active factory contract configured.");

  const cached = getCachedSnapshot(factoryKey);
  if (!force && cached && Number(cached.expiresAt || 0) > Date.now()) {
    return cached;
  }

  if (refreshes.has(factoryKey)) return refreshes.get(factoryKey);

  const refresh = (async () => {
    const addresses = await getDeployedAddresses(factoryAddress, force);
    const knownActive = (cached?.activeAuctions || []).map((auction) => auction.address);
    const discovery = addresses.slice(-DISCOVERY_WINDOW).reverse();
    const candidates = [...new Set([...knownActive, ...discovery])];
    const auctions = await readAuctionSummaries(candidates, factoryAddress);
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    return saveSnapshot({
      factoryAddress,
      updatedAt: now,
      expiresAt: now + SNAPSHOT_TTL_MS,
      source: "shared-chain-refresh",
      activeAuctions: auctions.filter(
        (auction) => !auction.closed && auction.endTimeSec > nowSec,
      ),
      finalizableAuctions: auctions.filter(
        (auction) =>
          !auction.closed &&
          auction.endTimeSec <= nowSec &&
          auction.approversCount > 0,
      ),
    });
  })().finally(() => refreshes.delete(factoryKey));

  refreshes.set(factoryKey, refresh);
  return refresh;
};

export const invalidateActiveAuctionRegistry = (
  factoryAddress = getActiveFactoryAddress(),
) => {
  const factoryKey = normalizeAddress(factoryAddress);
  const current = getCachedSnapshot(factoryKey);
  if (current) saveSnapshot({ ...current, expiresAt: 0 });
  deployedAddresses.delete(factoryKey);
};
