import { readOnlyBatchCall, readOnlyCall, readOnlyExecute } from "./readOnly";
import { getActiveFactoryAddress } from "./marketConfig";

const STORAGE_PREFIX = "data-market:active-auctions:v2";
const LEGACY_STORAGE_PREFIX = "data-market:active-auctions:v1";
const HISTORY_STORAGE_PREFIX = "data-market:active-auctions:history:v1";
const REFRESH_LEASE_PREFIX = "data-market:active-auctions:refresh-lease";
const COORDINATOR_LEASE_PREFIX = "data-market:active-auctions:coordinator-lease";
const CHANNEL_NAME = "data-market:active-auctions";
const SNAPSHOT_TTL_MS = Math.max(
  5000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_TTL_MS || 15000),
);
const STORED_MAX_AGE_MS = 10 * 60 * 1000;
const DEPLOYED_ADDRESSES_TTL_MS = Math.max(
  10000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_DISCOVERY_TTL_MS || 5 * 60 * 1000),
);
const FULL_RECONCILE_MS = Math.max(
  60000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_FULL_RECONCILE_MS || 5 * 60 * 1000),
);
const RECONCILE_PAGE_SIZE = Math.max(
  20,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_RECONCILE_PAGE_SIZE || 40),
);
const RECENT_RECHECK_MS = Math.max(
  30000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_RECENT_RECHECK_MS || 60000),
);
const DISCOVERY_WINDOW = Math.max(
  20,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_DISCOVERY_WINDOW || 80),
);
const READ_BATCH_SIZE = Math.max(
  5,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_BATCH_SIZE || 15),
);
const EVENT_BLOCK_WINDOW = Math.max(
  100,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_EVENT_BLOCK_WINDOW || 2000),
);
const REFRESH_LEASE_MS = Math.max(
  10000,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_REFRESH_LEASE_MS || 30000),
);
const COORDINATOR_LEASE_MS = Math.max(
  10000,
  Number(process.env.REACT_APP_BOT_COORDINATOR_LEASE_MS || 20000),
);
const REGISTRY_SYNC_INTERVAL_MS = Math.max(
  1500,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_SYNC_MS || 3000),
);
const DEADLINE_SYNC_GRACE_MS = 150;
const ENDED_VERIFICATION_GRACE_SEC = Math.max(
  30,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_END_GRACE_SEC || 120),
);
const HISTORY_MAX_ENTRIES = Math.max(
  50,
  Number(process.env.REACT_APP_ACTIVE_AUCTION_HISTORY_LIMIT || 250),
);
const HISTORY_MAX_AGE_MS = Math.max(
  24 * 60 * 60 * 1000,
  Number(
    process.env.REACT_APP_ACTIVE_AUCTION_HISTORY_MAX_AGE_MS ||
      30 * 24 * 60 * 60 * 1000,
  ),
);
const STORAGE_PERSIST_INTERVAL_MS = 1000;

const snapshots = new Map();
const snapshotHistories = new Map();
const historyPersistence = new Map();
const snapshotPersistence = new Map();
const refreshes = new Map();
const deployedAddresses = new Map();
const verifiedAddresses = new Map();
const registrySyncs = new Map();
const subscribers = new Set();
const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let broadcastChannel = null;

const normalizeAddress = (value) => String(value || "").trim().toLowerCase();
const storageKey = (factoryAddress) =>
  `${STORAGE_PREFIX}:${normalizeAddress(factoryAddress)}`;
const legacyStorageKey = (factoryAddress) =>
  `${LEGACY_STORAGE_PREFIX}:${normalizeAddress(factoryAddress)}`;
const historyStorageKey = (factoryAddress) =>
  `${HISTORY_STORAGE_PREFIX}:${normalizeAddress(factoryAddress)}`;
const refreshLeaseKey = (factoryAddress) =>
  `${REFRESH_LEASE_PREFIX}:${normalizeAddress(factoryAddress)}`;
const coordinatorLeaseKey = (factoryAddress) =>
  `${COORDINATOR_LEASE_PREFIX}:${normalizeAddress(factoryAddress)}`;

const getStorage = () => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage || null;
  } catch (_) {
    return null;
  }
};

const normalizeAuction = (auction = {}) => ({
  address: String(auction.address || ""),
  minimumContribution: String(auction.minimumContribution || "0"),
  approversCount: Number(auction.approversCount || 0),
  manager: String(auction.manager || ""),
  highestBid: String(auction.highestBid || "0"),
  highestBidder: String(auction.highestBidder || ""),
  endTimeSec: Math.floor(
    Number(
      auction.endTimeSec ||
        (Number(auction.endTime || 0) > 100000000000
          ? Number(auction.endTime) / 1000
          : Number(auction.endTime || 0)),
    ),
  ),
  closed: Boolean(auction.closed),
});

const mergeAuctions = (...groups) => {
  const byAddress = new Map();
  groups.flat().forEach((auction) => {
    const normalized = normalizeAuction(auction);
    const key = normalizeAddress(normalized.address);
    if (key) byAddress.set(key, normalized);
  });
  return [...byAddress.values()];
};

const classifyAuctions = (auctions, nowSec = Math.floor(Date.now() / 1000)) => {
  const tracked = mergeAuctions(auctions);
  return {
    activeAuctions: tracked
      .filter((auction) => !auction.closed && auction.endTimeSec > nowSec)
      .sort((a, b) => a.endTimeSec - b.endTimeSec),
    finalizableAuctions: tracked
      .filter(
        (auction) =>
          !auction.closed &&
          auction.endTimeSec > 0 &&
          auction.endTimeSec <= nowSec &&
          (auction.approversCount > 0 ||
            auction.endTimeSec + ENDED_VERIFICATION_GRACE_SEC > nowSec),
      )
      .sort((a, b) => a.endTimeSec - b.endTimeSec)
      .slice(0, 100),
  };
};

const normalizeSnapshot = (snapshot = {}) => {
  const classified = classifyAuctions([
    ...(snapshot.activeAuctions || []),
    ...(snapshot.finalizableAuctions || []),
  ]);

  return {
    version: 2,
    factoryAddress: String(snapshot.factoryAddress || ""),
    updatedAt: Number(snapshot.updatedAt || 0),
    expiresAt: Number(snapshot.expiresAt || 0),
    lastFullReconcileAt: Number(snapshot.lastFullReconcileAt || 0),
    reconcileCursor: Number(snapshot.reconcileCursor || 0),
    eventCursor: Number(snapshot.eventCursor || 0),
    source: String(snapshot.source || "unknown"),
    discoveryMode: String(snapshot.discoveryMode || "published"),
    knownAddressCount: Number(snapshot.knownAddressCount || 0),
    unreadableCount: Number(snapshot.unreadableCount || 0),
    ...classified,
  };
};

const snapshotStateSignature = (snapshot = {}) =>
  JSON.stringify({
    knownAddressCount: Number(snapshot.knownAddressCount || 0),
    unreadableCount: Number(snapshot.unreadableCount || 0),
    activeAuctions: (snapshot.activeAuctions || [])
      .map(normalizeAuction)
      .sort((left, right) =>
        normalizeAddress(left.address).localeCompare(normalizeAddress(right.address)),
      ),
    finalizableAuctions: (snapshot.finalizableAuctions || [])
      .map(normalizeAuction)
      .sort((left, right) =>
        normalizeAddress(left.address).localeCompare(normalizeAddress(right.address)),
      ),
  });

const readStoredHistory = (factoryAddress) => {
  const factoryKey = normalizeAddress(factoryAddress);
  if (!factoryKey) return [];
  if (snapshotHistories.has(factoryKey)) return snapshotHistories.get(factoryKey);

  const storage = getStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(historyStorageKey(factoryKey)) || "[]");
    const history = Array.isArray(parsed) ? parsed : [];
    snapshotHistories.set(factoryKey, history);
    return history;
  } catch (_) {
    return [];
  }
};

const requiresImmediatePersistence = (source = "") =>
  /(created|closed|finalized|deadline)/i.test(String(source));

const persistSnapshotHistory = (factoryKey, history, source = "") => {
  const latestSignature = history[history.length - 1]?.signature || "";
  const persisted = historyPersistence.get(factoryKey);
  if (persisted?.signature === latestSignature) return;
  if (
    persisted &&
    !requiresImmediatePersistence(source) &&
    Date.now() - persisted.at < STORAGE_PERSIST_INTERVAL_MS
  ) {
    return;
  }

  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(historyStorageKey(factoryKey), JSON.stringify(history));
    historyPersistence.set(factoryKey, { at: Date.now(), signature: latestSignature });
  } catch (_) {
    try {
      const compact = history.slice(
        -Math.max(25, Math.floor(HISTORY_MAX_ENTRIES / 2)),
      );
      snapshotHistories.set(factoryKey, compact);
      storage.setItem(historyStorageKey(factoryKey), JSON.stringify(compact));
      historyPersistence.set(factoryKey, {
        at: Date.now(),
        signature: compact[compact.length - 1]?.signature || "",
      });
    } catch (_) {
      // The in-memory audit trail remains available for this browser session.
    }
  }
};

const recordSnapshotHistory = (snapshot) => {
  const factoryKey = normalizeAddress(snapshot.factoryAddress);
  if (!factoryKey) return;

  const observedAt = Number(snapshot.updatedAt || Date.now());
  const signature = snapshotStateSignature(snapshot);
  const current = readStoredHistory(factoryKey);
  const previous = current[current.length - 1];
  if (previous?.signature === signature) {
    persistSnapshotHistory(factoryKey, current, snapshot.source);
    return;
  }
  const coalesceSameTick = Number(previous?.observedAt || 0) === observedAt;

  const entry = {
    stateId: `${factoryKey}:${observedAt}:${current.length}`,
    observedAt,
    observedAtIso: new Date(observedAt).toISOString(),
    factoryAddress: snapshot.factoryAddress,
    source: snapshot.source,
    discoveryMode: snapshot.discoveryMode,
    eventCursor: Number(snapshot.eventCursor || 0),
    knownAddressCount: Number(snapshot.knownAddressCount || 0),
    unreadableCount: Number(snapshot.unreadableCount || 0),
    activeAuctions: (snapshot.activeAuctions || []).map(normalizeAuction),
    finalizableAuctions: (snapshot.finalizableAuctions || []).map(normalizeAuction),
    signature,
  };
  const oldestAllowed = observedAt - HISTORY_MAX_AGE_MS;
  const history = [
    ...(coalesceSameTick ? current.slice(0, -1) : current),
    entry,
  ]
    .filter((item) => Number(item.observedAt || 0) >= oldestAllowed)
    .slice(-HISTORY_MAX_ENTRIES);
  snapshotHistories.set(factoryKey, history);

  persistSnapshotHistory(factoryKey, history, snapshot.source);
};

const persistLatestSnapshot = (factoryKey, snapshot) => {
  const persisted = snapshotPersistence.get(factoryKey);
  if (
    persisted &&
    !requiresImmediatePersistence(snapshot.source) &&
    Date.now() - persisted.at < STORAGE_PERSIST_INTERVAL_MS
  ) {
    return;
  }
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(factoryKey), JSON.stringify(snapshot));
    storage.removeItem(legacyStorageKey(factoryKey));
    snapshotPersistence.set(factoryKey, { at: Date.now() });
  } catch (_) {
    // The in-memory registry remains available when browser storage is full.
  }
};

const notifySubscribers = (snapshot) => {
  subscribers.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (_) {
      // Registry listeners are observational and must not break discovery.
    }
  });
};

const acceptSnapshot = (snapshot, { broadcast = false, persist = true } = {}) => {
  const normalized = normalizeSnapshot(snapshot);
  const factoryKey = normalizeAddress(normalized.factoryAddress);
  if (!factoryKey) return normalized;

  const current = snapshots.get(factoryKey);
  if (current && current.updatedAt > normalized.updatedAt) return current;

  snapshots.set(factoryKey, normalized);
  recordSnapshotHistory(normalized);
  if (persist) persistLatestSnapshot(factoryKey, normalized);

  notifySubscribers(normalized);
  if (broadcast) {
    try {
      getBroadcastChannel()?.postMessage({ type: "snapshot", snapshot: normalized });
    } catch (_) {
      // localStorage still provides eventual cross-tab recovery.
    }
  }
  return normalized;
};

const getBroadcastChannel = () => {
  if (
    broadcastChannel ||
    typeof window === "undefined" ||
    typeof window.BroadcastChannel === "undefined"
  ) {
    return broadcastChannel;
  }

  try {
    broadcastChannel = new window.BroadcastChannel(CHANNEL_NAME);
    broadcastChannel.addEventListener("message", (event) => {
      if (event?.data?.type === "snapshot" && event.data.snapshot) {
        acceptSnapshot(event.data.snapshot, { broadcast: false, persist: true });
      }
    });
  } catch (_) {
    broadcastChannel = null;
  }
  return broadcastChannel;
};

const readStoredSnapshot = (factoryAddress) => {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw =
      storage.getItem(storageKey(factoryAddress)) ||
      storage.getItem(legacyStorageKey(factoryAddress));
    const stored = JSON.parse(raw || "null");
    if (
      !stored ||
      normalizeAddress(stored.factoryAddress) !== normalizeAddress(factoryAddress) ||
      Date.now() - Number(stored.updatedAt || 0) > STORED_MAX_AGE_MS
    ) {
      return null;
    }
    return normalizeSnapshot(stored);
  } catch (_) {
    return null;
  }
};

const getCachedSnapshot = (factoryAddress) => {
  const factoryKey = normalizeAddress(factoryAddress);
  if (!factoryKey) return null;

  const memory = snapshots.get(factoryKey);
  if (memory) return normalizeSnapshot(memory);

  const stored = readStoredSnapshot(factoryKey);
  if (stored) snapshots.set(factoryKey, stored);
  return stored;
};

const sameAuctionMembership = (left = {}, right = {}) => {
  const keys = (snapshot, field) =>
    (snapshot?.[field] || [])
      .map((auction) => normalizeAddress(auction.address))
      .filter(Boolean)
      .sort()
      .join("|");

  return (
    keys(left, "activeAuctions") === keys(right, "activeAuctions") &&
    keys(left, "finalizableAuctions") === keys(right, "finalizableAuctions")
  );
};

const reclassifyTrackedAuctions = (
  factoryAddress,
  source = "deadline-transition",
) => {
  const current = getCachedSnapshot(factoryAddress);
  if (!current) return null;

  const classified = classifyAuctions([
    ...(current.activeAuctions || []),
    ...(current.finalizableAuctions || []),
  ]);
  const next = { ...current, ...classified };
  if (sameAuctionMembership(current, next)) return current;

  const now = Date.now();
  return acceptSnapshot(
    {
      ...next,
      updatedAt: now,
      expiresAt: 0,
      source,
    },
    { broadcast: true },
  );
};

const getNextSyncDelay = (snapshot, intervalMs) => {
  const nextEndMs = Math.min(
    ...(snapshot?.activeAuctions || [])
      .map((auction) => Number(auction.endTimeSec || 0) * 1000)
      .filter((endTimeMs) => endTimeMs > Date.now()),
  );
  if (!Number.isFinite(nextEndMs)) return intervalMs;

  return Math.max(
    50,
    Math.min(intervalMs, nextEndMs - Date.now() + DEADLINE_SYNC_GRACE_MS),
  );
};

const readLease = (key) => {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch (_) {
    return null;
  }
};

const acquireLease = (key, durationMs) => {
  const storage = getStorage();
  if (!storage) return true;

  const now = Date.now();
  const current = readLease(key);
  if (current && current.owner !== instanceId && Number(current.expiresAt || 0) > now) {
    return false;
  }

  const lease = { owner: instanceId, expiresAt: now + durationMs };
  try {
    storage.setItem(key, JSON.stringify(lease));
    return readLease(key)?.owner === instanceId;
  } catch (_) {
    return true;
  }
};

const releaseLease = (key) => {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (readLease(key)?.owner === instanceId) storage.removeItem(key);
  } catch (_) {
    // A lease always expires, so cleanup is best effort.
  }
};

const waitForSharedSnapshot = async (factoryAddress, leaseKey) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < REFRESH_LEASE_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const shared = readStoredSnapshot(factoryAddress);
    if (shared && shared.updatedAt >= startedAt) {
      return acceptSnapshot(shared, { broadcast: false, persist: false });
    }
    const lease = readLease(leaseKey);
    if (!lease || Number(lease.expiresAt || 0) <= Date.now()) break;
  }
  return null;
};

if (typeof window !== "undefined") {
  getBroadcastChannel();
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(`${STORAGE_PREFIX}:`) || !event.newValue) return;
    try {
      acceptSnapshot(JSON.parse(event.newValue), { broadcast: false, persist: false });
    } catch (_) {
      // Ignore malformed data written by old or unrelated clients.
    }
  });
}

export const subscribeActiveAuctionRegistry = (listener) => {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
};

export const getActiveAuctionSnapshot = (
  factoryAddress = getActiveFactoryAddress(),
) => getCachedSnapshot(factoryAddress);

export const getActiveAuctionStateHistory = (
  factoryAddress = getActiveFactoryAddress(),
  { fromMs = null, toMs = null, includeBaseline = true } = {},
) => {
  const history = [...readStoredHistory(factoryAddress)].sort(
    (left, right) => Number(left.observedAt || 0) - Number(right.observedAt || 0),
  );
  const validFrom = fromMs !== null && Number.isFinite(Number(fromMs))
    ? Number(fromMs)
    : null;
  const validTo = toMs !== null && Number.isFinite(Number(toMs))
    ? Number(toMs)
    : null;
  const inRange = history
    .filter((entry) => validFrom === null || Number(entry.observedAt) >= validFrom)
    .filter((entry) => validTo === null || Number(entry.observedAt) <= validTo)
    .map((entry) => ({ ...entry, boundaryRole: "Observed transition" }));

  if (!includeBaseline || validFrom === null) return inRange;
  const baseline = [...history]
    .reverse()
    .find((entry) => Number(entry.observedAt) < validFrom);
  return baseline
    ? [{ ...baseline, boundaryRole: "Baseline at range start" }, ...inRange]
    : inRange;
};

export const publishActiveAuctions = (
  factoryAddress = getActiveFactoryAddress(),
  auctions = [],
  source = "website",
) => {
  const now = Date.now();
  const existing = getCachedSnapshot(factoryAddress);
  const classified = classifyAuctions([
    ...(existing?.activeAuctions || []),
    ...(existing?.finalizableAuctions || []),
    ...auctions,
  ]);

  return acceptSnapshot(
    {
      ...existing,
      factoryAddress,
      updatedAt: now,
      expiresAt: now + SNAPSHOT_TTL_MS,
      source,
      discoveryMode: "published",
      ...classified,
    },
    { broadcast: true },
  );
};

export const registerCreatedAuction = (
  factoryAddress = getActiveFactoryAddress(),
  auction = {},
  source = "auction-created",
) => publishActiveAuctions(factoryAddress, [auction], source);

export const markAuctionClosed = (
  factoryAddress = getActiveFactoryAddress(),
  auctionAddress,
  source = "auction-closed",
) => {
  const existing = getCachedSnapshot(factoryAddress);
  const tracked = [
    ...(existing?.activeAuctions || []),
    ...(existing?.finalizableAuctions || []),
  ].map((auction) =>
    normalizeAddress(auction.address) === normalizeAddress(auctionAddress)
      ? { ...auction, closed: true }
      : auction,
  );
  return publishActiveAuctions(factoryAddress, tracked, source);
};

export const getCreatedAuctionAddress = (receipt = {}) => {
  const events = receipt.events || {};
  const candidates = [events.AuctionCreatedDetailed, events.AuctionCreated]
    .flatMap((event) => (Array.isArray(event) ? event : [event]))
    .filter(Boolean);

  for (const event of candidates) {
    const values = event.returnValues || {};
    const address =
      values.auction || values.campaign || values.campaignAddress || values[0];
    if (/^0x[a-fA-F0-9]{40}$/.test(String(address || ""))) return address;
  }
  return "";
};

export const registerCreatedAuctionReceipt = (
  factoryAddress = getActiveFactoryAddress(),
  receipt = {},
  auction = {},
  source = "auction-created",
) => {
  const address = getCreatedAuctionAddress(receipt);
  if (!address) {
    invalidateActiveAuctionRegistry(factoryAddress);
    return null;
  }

  return registerCreatedAuction(
    factoryAddress,
    { ...auction, address, closed: false },
    source,
  );
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
      preferInjected: false,
      allowInjectedFallback: true,
    },
  );
  deployedAddresses.set(key, { addresses, updatedAt: Date.now() });
  return addresses;
};

const getCreatedAuctionEvents = async (factoryAddress, eventCursor = 0) =>
  readOnlyExecute(
    async ({ web3, factory }) => {
      const latestBlock = Number(await web3.eth.getBlockNumber());
      if (!eventCursor) return { auctions: [], latestBlock, scannedToBlock: latestBlock };

      const fromBlock = Math.min(latestBlock, Number(eventCursor) + 1);
      const toBlock = Math.min(latestBlock, fromBlock + EVENT_BLOCK_WINDOW - 1);
      if (fromBlock > toBlock) {
        return { auctions: [], latestBlock, scannedToBlock: latestBlock };
      }

      const events = await factory.getPastEvents("AuctionCreatedDetailed", {
        fromBlock,
        toBlock,
      });
      return {
        latestBlock,
        scannedToBlock: toBlock,
        auctions: events.map((event) => {
          const values = event.returnValues || {};
          return normalizeAuction({
            address: values.campaignAddress || values[0],
            manager: values.seller || values[1],
            minimumContribution: values.minimum || values[2],
            endTimeSec: values.endTime || values[3],
            closed: false,
          });
        }),
      };
    },
    undefined,
    {
      factoryAddress,
      preferInjected: false,
      allowInjectedFallback: true,
    },
  );

const getVerificationMap = (factoryAddress) => {
  const key = normalizeAddress(factoryAddress);
  if (!verifiedAddresses.has(key)) verifiedAddresses.set(key, new Map());
  return verifiedAddresses.get(key);
};

const readAuctionSummaries = async (addresses, factoryAddress) => {
  const auctions = [];
  const failedAddresses = [];
  const verificationMap = getVerificationMap(factoryAddress);

  for (let offset = 0; offset < addresses.length; offset += READ_BATCH_SIZE) {
    const chunk = addresses.slice(offset, offset + READ_BATCH_SIZE);
    const results = await readOnlyBatchCall(
      ({ campaign }) =>
        chunk.map((address) => campaign(address).methods.getListSummary()),
      undefined,
      {
        factoryAddress,
        preferInjected: false,
        allowInjectedFallback: true,
      },
    );

    results.forEach((result, index) => {
      if (result?.status !== "fulfilled") {
        failedAddresses.push(chunk[index]);
        verificationMap.set(normalizeAddress(chunk[index]), Date.now());
        return;
      }
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
      verificationMap.set(normalizeAddress(chunk[index]), Date.now());
    });
  }

  return { auctions, failedAddresses };
};

export const refreshActiveAuctionRegistry = async (
  factoryAddress = getActiveFactoryAddress(),
  { force = false, full = false } = {},
) => {
  const factoryKey = normalizeAddress(factoryAddress);
  if (!factoryKey) throw new Error("No active factory contract configured.");

  const cached = getCachedSnapshot(factoryKey);
  if (!force && cached && Number(cached.expiresAt || 0) > Date.now()) {
    return cached;
  }
  if (refreshes.has(factoryKey)) return refreshes.get(factoryKey);

  const leaseKey = refreshLeaseKey(factoryKey);
  if (!acquireLease(leaseKey, REFRESH_LEASE_MS)) {
    if (cached) return cached;
    const shared = await waitForSharedSnapshot(factoryKey, leaseKey);
    if (shared) return shared;
    if (!acquireLease(leaseKey, REFRESH_LEASE_MS)) {
      throw new Error("Another browser tab is refreshing the active auction list.");
    }
  }

  const refresh = (async () => {
    const baseline = getCachedSnapshot(factoryKey) || cached;
    const now = Date.now();
    const reconciliationDue =
      full ||
      Number(baseline?.reconcileCursor || 0) > 0 ||
      !baseline?.lastFullReconcileAt ||
      now - baseline.lastFullReconcileAt >= FULL_RECONCILE_MS;
    const tracked = [
      ...(baseline?.activeAuctions || []),
      ...(baseline?.finalizableAuctions || []),
    ];
    let eventDiscovery = {
      auctions: [],
      latestBlock: Number(baseline?.eventCursor || 0),
      scannedToBlock: Number(baseline?.eventCursor || 0),
    };
    try {
      eventDiscovery = await getCreatedAuctionEvents(
        factoryAddress,
        Number(baseline?.eventCursor || 0),
      );
    } catch (_) {
      // Reconciliation remains the recovery path if an RPC rejects event queries.
    }
    const needsAddressList =
      reconciliationDue || !Number(baseline?.eventCursor || 0);
    const addresses = needsAddressList
      ? await getDeployedAddresses(factoryAddress, full)
      : [];
    const trackedAddresses = tracked.map((auction) => auction.address);
    const verificationMap = getVerificationMap(factoryAddress);
    const recentDiscovery = addresses
      .slice(-DISCOVERY_WINDOW)
      .reverse()
      .filter(
        (address) =>
          now - Number(verificationMap.get(normalizeAddress(address)) || 0) >=
          RECENT_RECHECK_MS,
      );
    const reconcileCursor = reconciliationDue
      ? Math.min(Number(baseline?.reconcileCursor || 0), addresses.length)
      : 0;
    const reconcileEnd = reconciliationDue
      ? Math.min(addresses.length, reconcileCursor + RECONCILE_PAGE_SIZE)
      : reconcileCursor;
    const reconcilePage = reconciliationDue
      ? addresses.slice(reconcileCursor, reconcileEnd)
      : [];
    const eventAddresses = eventDiscovery.auctions.map((auction) => auction.address);
    const candidates = [...new Set([
      ...trackedAddresses,
      ...eventAddresses,
      ...recentDiscovery,
      ...reconcilePage,
    ])];
    const { auctions, failedAddresses } = await readAuctionSummaries(
      candidates,
      factoryAddress,
    );
    const failed = new Set(failedAddresses.map(normalizeAddress));
    const preserved = tracked.filter((auction) => failed.has(normalizeAddress(auction.address)));
    let refreshedAuctions = [
      ...preserved,
      ...eventDiscovery.auctions,
      ...auctions,
    ];

    // Preserve direct creation/closure updates that landed while RPC reads were
    // in flight. A refresh must never resurrect a just-closed auction or drop a
    // just-created one.
    const latest = getCachedSnapshot(factoryKey);
    if (latest && latest !== baseline) {
      const baselineKeys = new Set(tracked.map((auction) => normalizeAddress(auction.address)));
      const latestTracked = [
        ...(latest.activeAuctions || []),
        ...(latest.finalizableAuctions || []),
      ];
      const latestKeys = new Set(
        latestTracked.map((auction) => normalizeAddress(auction.address)),
      );
      const removedDuringRefresh = new Set(
        [...baselineKeys].filter((address) => !latestKeys.has(address)),
      );
      refreshedAuctions = [
        ...refreshedAuctions.filter(
          (auction) => !removedDuringRefresh.has(normalizeAddress(auction.address)),
        ),
        ...latestTracked,
      ];
    }
    const classified = classifyAuctions(refreshedAuctions);
    const completedAt = Date.now();
    const reconciliationComplete =
      reconciliationDue && reconcileEnd >= addresses.length;

    return acceptSnapshot(
      {
        factoryAddress,
        updatedAt: completedAt,
        expiresAt: completedAt + SNAPSHOT_TTL_MS,
        lastFullReconcileAt: reconciliationComplete
          ? completedAt
          : Number(baseline?.lastFullReconcileAt || 0),
        reconcileCursor:
          reconciliationDue && !reconciliationComplete ? reconcileEnd : 0,
        eventCursor: Number(
          eventDiscovery.scannedToBlock || baseline?.eventCursor || 0,
        ),
        source: reconciliationDue
          ? "shared-rolling-reconcile"
          : "shared-chain-refresh",
        discoveryMode: reconciliationDue ? "reconciliation" : "incremental",
        knownAddressCount: needsAddressList
          ? addresses.length
          : Math.max(
              Number(baseline?.knownAddressCount || 0),
              Number(latest?.knownAddressCount || 0),
            ) + eventDiscovery.auctions.length,
        unreadableCount: failedAddresses.length,
        ...classified,
      },
      { broadcast: true },
    );
  })().finally(() => {
    refreshes.delete(factoryKey);
    releaseLease(leaseKey);
  });

  refreshes.set(factoryKey, refresh);
  return refresh;
};

export const startActiveAuctionRegistrySync = (
  factoryAddress = getActiveFactoryAddress(),
  { intervalMs = REGISTRY_SYNC_INTERVAL_MS } = {},
) => {
  const factoryKey = normalizeAddress(factoryAddress);
  if (!factoryKey || typeof window === "undefined") return () => {};

  const existing = registrySyncs.get(factoryKey);
  if (existing) {
    existing.references += 1;
    return () => {
      existing.references -= 1;
      if (existing.references <= 0) existing.stop();
    };
  }

  const controller = {
    references: 1,
    stopped: false,
    running: false,
    timer: null,
    schedule(delay = intervalMs) {
      if (controller.stopped) return;
      window.clearTimeout(controller.timer);
      controller.timer = window.setTimeout(controller.run, Math.max(50, delay));
    },
    async run() {
      if (controller.stopped || controller.running) return;
      controller.running = true;
      try {
        reclassifyTrackedAuctions(factoryAddress);
        await refreshActiveAuctionRegistry(factoryAddress, { force: true });
      } catch (_) {
        // The cached list remains usable; the next short incremental pass heals it.
      } finally {
        controller.running = false;
        const snapshot = reclassifyTrackedAuctions(factoryAddress);
        controller.schedule(getNextSyncDelay(snapshot, intervalMs));
      }
    },
    wake() {
      controller.schedule(50);
    },
    stop() {
      if (controller.stopped) return;
      controller.stopped = true;
      window.clearTimeout(controller.timer);
      window.removeEventListener("focus", controller.wake);
      window.removeEventListener("online", controller.wake);
      registrySyncs.delete(factoryKey);
    },
  };

  registrySyncs.set(factoryKey, controller);
  window.addEventListener("focus", controller.wake);
  window.addEventListener("online", controller.wake);
  controller.schedule(0);

  return () => {
    controller.references -= 1;
    if (controller.references <= 0) controller.stop();
  };
};

export const acquireActiveAuctionCoordinatorLease = (
  factoryAddress = getActiveFactoryAddress(),
) => acquireLease(coordinatorLeaseKey(factoryAddress), COORDINATOR_LEASE_MS);

export const releaseActiveAuctionCoordinatorLease = (
  factoryAddress = getActiveFactoryAddress(),
) => releaseLease(coordinatorLeaseKey(factoryAddress));

export const invalidateActiveAuctionRegistry = (
  factoryAddress = getActiveFactoryAddress(),
) => {
  const factoryKey = normalizeAddress(factoryAddress);
  const current = getCachedSnapshot(factoryKey);
  if (current) {
    acceptSnapshot(
      { ...current, updatedAt: Date.now(), expiresAt: 0, source: "invalidated" },
      { broadcast: true },
    );
  }
  deployedAddresses.delete(factoryKey);
};

export const __resetActiveAuctionRegistryForTests = () => {
  registrySyncs.forEach((controller) => controller.stop());
  registrySyncs.clear();
  snapshots.clear();
  snapshotHistories.clear();
  historyPersistence.clear();
  snapshotPersistence.clear();
  refreshes.clear();
  deployedAddresses.clear();
  verifiedAddresses.clear();
  subscribers.clear();
  const storage = getStorage();
  if (storage) {
    Object.keys(storage)
      .filter(
        (key) =>
          key.startsWith(STORAGE_PREFIX) ||
          key.startsWith(LEGACY_STORAGE_PREFIX) ||
          key.startsWith(HISTORY_STORAGE_PREFIX) ||
          key.startsWith(REFRESH_LEASE_PREFIX) ||
          key.startsWith(COORDINATOR_LEASE_PREFIX),
      )
      .forEach((key) => storage.removeItem(key));
  }
};
