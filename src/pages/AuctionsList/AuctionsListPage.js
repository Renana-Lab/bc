import React, {
  useState,
  useEffect,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
} from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Paper,
  CircularProgress,
  TextField,
  InputAdornment,
  IconButton,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import { useNavigate, useLocation } from "react-router-dom";
import { readOnlyBatchCall, readOnlyCall } from "../../real_ethereum/readOnly";
import {
  campaignSocket,
  factorySocket,
  shouldLimitLiveEventLoad,
} from "../../real_ethereum/socketFactory";
import {
  getActiveFactoryAddress,
  subscribeToMarketChanges,
} from "../../real_ethereum/marketConfig";
import Layout from "../../components/Layout";
import styles from "./auctions.module.scss";
import picSrc from "./Illustration_Start.png";

const AUCTIONS_PAGE_SIZE = 20;
const FETCH_CONCURRENCY = 2;
const BATCH_READ_SIZE = 10;
const BATCH_READ_CONCURRENCY = 1;
const POLL_INTERVAL_MS = 15000;
const MAX_LIVE_BID_SUBSCRIPTIONS = 6;
const STATUS_TICK_FAST_MS = 1000;
const STATUS_TICK_BASE_MS = 5000;
const STATUS_TICK_IDLE_MS = 15000;
const FAST_STATUS_TICK_WINDOW_MS = 60000;
const EVENT_REFRESH_DELAY_MS = 900;
const CACHE_TTL_MS = 15000;
const DEPLOYED_CAMPAIGNS_TTL_MS = 60000;
const USER_STATUS_TTL_MS = 8000;
const RATE_LIMIT_COOLDOWN_MS = 45000;
const LOCAL_AUCTIONS_CACHE_PREFIX = "data-market:auctions:v5";
const LOCAL_AUCTIONS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const AUCTIONS_API_URL = (process.env.REACT_APP_AUCTION_API_URL || "").replace(
  /\/$/,
  "",
);

const SORT_OPTIONS = [
  { value: "normal", label: "Market order" },
  { value: "ending", label: "Ending soon" },
  { value: "highest", label: "Highest bid" },
  { value: "bidders", label: "Most bidders" },
];

let auctionListCache = {
  factoryAddress: "",
  data: [],
  total: 0,
  visibleCount: 0,
  updatedAt: 0,
};
let deployedCampaignsCache = {
  factoryAddress: "",
  data: [],
  updatedAt: 0,
};
let auctionListInFlight = null;
let auctionReadRateLimitedUntil = 0;
const budgetCache = new Map();
const budgetInFlight = new Map();
const userAuctionStatusCache = new Map();
let userAuctionStatusInFlight = null;

const normalizeSearchText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\bwei\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const normalizeAddressText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-f0-9x]+/g, "");

const normalizeFactoryAddress = (address) =>
  String(address || "")
    .trim()
    .toLowerCase();

const isRpcRateLimitError = (error) => {
  const message = JSON.stringify(error?.message || error || "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("usage limit") ||
    message.includes("current plan") ||
    message.includes("higher limits")
  );
};

const markAuctionReadRateLimited = () => {
  auctionReadRateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
};

const isAuctionReadCoolingDown = () => Date.now() < auctionReadRateLimitedUntil;

const getSearchKind = (rawQuery) => {
  const query = rawQuery.trim().toLowerCase();
  const withoutWei = query.replace(/\bwei\b/g, "").trim();

  if (/^\d+$/.test(withoutWei)) {
    return { kind: "number", value: withoutWei };
  }

  if (
    query.startsWith("0x") ||
    /^[a-f0-9]{6,}$/i.test(query.replace(/\s+/g, ""))
  ) {
    return { kind: "address", value: normalizeAddressText(query) };
  }

  const normalized = normalizeSearchText(query);
  return {
    kind: "text",
    value: normalized,
    tokens: normalized.split(/\s+/).filter(Boolean),
  };
};

const normalizeAuction = (auction) => ({
  ...auction,
  endTime: Number(auction.endTime),
  listOrder: Number(auction.listOrder ?? 0),
  addresses: auction.addresses || [],
  isRefunded: Boolean(auction.isRefunded),
  closed: Boolean(auction.closed),
  isReadPlaceholder: Boolean(auction.isReadPlaceholder),
});

const getLocalAuctionsCacheKey = (factoryAddress = getActiveFactoryAddress()) =>
  `${LOCAL_AUCTIONS_CACHE_PREFIX}:${normalizeFactoryAddress(factoryAddress)}`;

const readStoredAuctionListCache = (
  factoryAddress = getActiveFactoryAddress(),
) => {
  if (typeof window === "undefined" || !window.localStorage) return null;

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(getLocalAuctionsCacheKey(factoryAddress)) ||
        "null",
    );

    if (
      !stored?.data?.length ||
      Date.now() - Number(stored.updatedAt || 0) >
        LOCAL_AUCTIONS_CACHE_MAX_AGE_MS
    ) {
      return null;
    }

    return {
      factoryAddress: normalizeFactoryAddress(factoryAddress),
      data: sortByMarketOrder(stored.data.map(normalizeAuction)),
      total: Number(stored.total || stored.data.length),
      visibleCount: Math.min(
        Number(stored.visibleCount || stored.data.length),
        stored.data.length,
      ),
      updatedAt: Number(stored.updatedAt || Date.now()),
    };
  } catch (error) {
    return null;
  }
};

const writeStoredAuctionListCache = (
  cache,
  factoryAddress = getActiveFactoryAddress(),
) => {
  if (typeof window === "undefined" || !window.localStorage) return;

  try {
    const persistedData = cache.data
      .filter((auction) => !auction.isReadPlaceholder)
      .slice(0, 100);

    if (!persistedData.length) return;

    window.localStorage.setItem(
      getLocalAuctionsCacheKey(factoryAddress),
      JSON.stringify({
        data: persistedData,
        total: cache.total,
        visibleCount: Math.min(cache.visibleCount, persistedData.length),
        updatedAt: cache.updatedAt,
      }),
    );
  } catch (error) {
    // Storage is best-effort; the live chain read is still the source of truth.
  }
};

const sortByMarketOrder = (auctions) =>
  [...auctions].sort((a, b) => {
    const aHasDate = Number(a.endTime) > 0;
    const bHasDate = Number(b.endTime) > 0;
    if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;
    if (Number(b.endTime) !== Number(a.endTime)) {
      return Number(b.endTime) - Number(a.endTime);
    }
    if (b.listOrder !== a.listOrder) return b.listOrder - a.listOrder;
    return String(b.address).localeCompare(String(a.address));
  });

const cacheAuctionList = ({
  data,
  total,
  visibleCount,
  updatedAt,
  factoryAddress = getActiveFactoryAddress(),
}) => {
  const orderedData = sortByMarketOrder(data || []);
  const hasPlaceholders = orderedData.some(
    (auction) => auction.isReadPlaceholder,
  );
  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);

  auctionListCache = {
    factoryAddress: normalizedFactoryAddress,
    data: orderedData,
    total: Number(total ?? orderedData.length),
    visibleCount: Number(visibleCount ?? orderedData.length),
    updatedAt: updatedAt || Date.now(),
    partial: hasPlaceholders,
  };

  writeStoredAuctionListCache(auctionListCache, normalizedFactoryAddress);
  return auctionListCache;
};

const createAuctionPlaceholder = (address, listOrder) =>
  normalizeAuction({
    address,
    listOrder,
    minimumContribution: "",
    balance: "",
    approversCount: "",
    manager: "",
    highestBid: "",
    dataForSell: "",
    dataDescription: "Loading auction...",
    highestBidder: "",
    addresses: [],
    endTime: 0,
    isRefunded: false,
    closed: false,
    isReadPlaceholder: true,
  });

const LoadingAuctionLabel = () => (
  <span className={styles.inlineAuctionLoader}>
    <span className={styles.inlineLoaderTrack} aria-hidden="true" />
    <span>Loading auction</span>
    <span className={styles.inlineLoaderDots} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  </span>
);

const mergeReadAuctionsWithCache = (
  visibleAuctions,
  firstVisibleIndex,
  auctionData,
  factoryAddress = getActiveFactoryAddress(),
) => {
  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);
  const cachedByAddress = new Map(
    auctionListCache.factoryAddress === normalizedFactoryAddress
      ? auctionListCache.data.map((auction) => [
          auction.address.toLowerCase(),
          auction,
        ])
      : [],
  );

  return visibleAuctions.map((address, index) => {
    const readAuction = auctionData[index];
    if (readAuction) return readAuction;

    const cachedAuction = cachedByAddress.get(address.toLowerCase());
    if (cachedAuction && !cachedAuction.isReadPlaceholder) {
      return normalizeAuction({
        ...cachedAuction,
        listOrder: firstVisibleIndex + index,
      });
    }

    return createAuctionPlaceholder(address, firstVisibleIndex + index);
  });
};

const invalidateAuctionCaches = () => {
  auctionListCache = {
    factoryAddress: "",
    data: [],
    total: 0,
    visibleCount: 0,
    updatedAt: 0,
  };
  deployedCampaignsCache = {
    factoryAddress: "",
    data: [],
    updatedAt: 0,
  };
  auctionListInFlight = null;
  userAuctionStatusCache.clear();
  userAuctionStatusInFlight = null;
};

const getDeployedCampaigns = async (
  factoryAddress = getActiveFactoryAddress(),
) => {
  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);

  if (
    deployedCampaignsCache.factoryAddress === normalizedFactoryAddress &&
    deployedCampaignsCache.data.length &&
    Date.now() - deployedCampaignsCache.updatedAt < DEPLOYED_CAMPAIGNS_TTL_MS
  ) {
    return deployedCampaignsCache.data;
  }

  const data = await readOnlyCall(
    ({ factory }) => factory.methods.getDeployedCampaigns(),
    undefined,
    { factoryAddress },
  );

  deployedCampaignsCache = {
    factoryAddress: normalizedFactoryAddress,
    data,
    updatedAt: Date.now(),
  };

  return data;
};

export const getRemainingBudget = async (
  userAddress,
  factoryAddress = getActiveFactoryAddress(),
  { force = false } = {},
) => {
  if (!window.ethereum) return null;

  const accounts = userAddress
    ? [userAddress]
    : await window.ethereum.request({ method: "eth_accounts" });
  const account = accounts?.[0];

  if (!account) return null;

  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);
  const normalizedAccount = `${normalizedFactoryAddress}:${account.toLowerCase()}`;
  const cached = budgetCache.get(normalizedAccount);
  if (!force && cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.budget;
  }

  if (!force && budgetInFlight.has(normalizedAccount)) {
    return budgetInFlight.get(normalizedAccount);
  }

  const request = readOnlyCall(
    ({ factory }) => factory.methods.getBudget(account),
    undefined,
    { factoryAddress },
  )
    .then((budget) => {
      budgetCache.set(normalizedAccount, { budget, updatedAt: Date.now() });
      return budget;
    })
    .finally(() => {
      budgetInFlight.delete(normalizedAccount);
    });

  budgetInFlight.set(normalizedAccount, request);
  return request;
};

export const setRemainingBudgetCache = (
  userAddress,
  budget,
  factoryAddress = getActiveFactoryAddress(),
) => {
  if (!userAddress || budget === undefined || budget === null) return;

  budgetCache.set(
    `${normalizeFactoryAddress(factoryAddress)}:${userAddress.toLowerCase()}`,
    { budget: String(budget), updatedAt: Date.now() },
  );
};

export const invalidateRemainingBudgetCache = (
  userAddress,
  factoryAddress = getActiveFactoryAddress(),
) => {
  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);
  const normalizedUserAddress = String(userAddress || "").toLowerCase();

  Array.from(budgetCache.keys()).forEach((key) => {
    const [factoryKey, userKey] = key.split(":");
    const matchesFactory =
      !normalizedFactoryAddress || factoryKey === normalizedFactoryAddress;
    const matchesUser =
      !normalizedUserAddress || userKey === normalizedUserAddress;

    if (matchesFactory && matchesUser) budgetCache.delete(key);
  });

  Array.from(budgetInFlight.keys()).forEach((key) => {
    const [factoryKey, userKey] = key.split(":");
    const matchesFactory =
      !normalizedFactoryAddress || factoryKey === normalizedFactoryAddress;
    const matchesUser =
      !normalizedUserAddress || userKey === normalizedUserAddress;

    if (matchesFactory && matchesUser) budgetInFlight.delete(key);
  });
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    },
  );

  await Promise.all(workers);
  return results;
};

const getCachedAuctions = (
  visibleAuctionCount,
  factoryAddress = getActiveFactoryAddress(),
) => {
  const normalizedFactoryAddress = normalizeFactoryAddress(factoryAddress);

  if (
    auctionListCache.factoryAddress !== normalizedFactoryAddress ||
    !auctionListCache.data.length
  ) {
    const stored = readStoredAuctionListCache(factoryAddress);
    if (stored) auctionListCache = stored;
  }

  if (
    auctionListCache.factoryAddress === normalizedFactoryAddress &&
    auctionListCache.data.length &&
    auctionListCache.visibleCount >= visibleAuctionCount
  ) {
    const orderedData = sortByMarketOrder(auctionListCache.data);
    const data = orderedData.slice(0, visibleAuctionCount);
    const hasPlaceholders = data.some((auction) => auction.isReadPlaceholder);

    return {
      data,
      total: auctionListCache.total,
      updatedAt: auctionListCache.updatedAt,
      fresh:
        !hasPlaceholders &&
        Date.now() - auctionListCache.updatedAt < CACHE_TTL_MS,
    };
  }

  return null;
};

const readAuctionsFromApi = async (
  visibleAuctionCount,
  currentUserAddress,
  factoryAddress,
) => {
  if (!AUCTIONS_API_URL) return null;

  const params = new URLSearchParams({ limit: String(visibleAuctionCount) });
  if (currentUserAddress) params.set("user", currentUserAddress);
  if (factoryAddress) params.set("factory", factoryAddress);

  const response = await fetch(`${AUCTIONS_API_URL}/auctions?${params}`);
  if (!response.ok) {
    throw new Error(`Auction API failed with status ${response.status}`);
  }

  const payload = await response.json();
  const auctions = payload.data || payload.auctions || [];
  const total = Number(payload.total ?? payload.count ?? auctions.length);
  const expectedCount = Math.min(visibleAuctionCount, total);

  if (auctions.length < expectedCount) {
    throw new Error(
      `Auction API returned a partial page (${auctions.length}/${expectedCount})`,
    );
  }

  const firstVisibleIndex = Math.max(0, total - auctions.length);
  const data = auctions.map((auction, index) =>
    normalizeAuction({
      ...auction,
      listOrder: auction.listOrder ?? firstVisibleIndex + index,
    }),
  );

  return cacheAuctionList({
    data,
    total,
    visibleCount: visibleAuctionCount,
    updatedAt: Date.now(),
    factoryAddress,
  });
};

const readAuctionFromChain = async (
  address,
  currentUserAddress,
  listOrder = 0,
  options = {},
) => {
  const readOptions = {
    preferInjected: options.preferInjected !== false,
    allowInjectedFallback: options.allowInjectedFallback !== false,
    factoryAddress: options.factoryAddress,
  };

  try {
    const details = await readOnlyCall(
      ({ campaign }) => campaign(address).methods.getListSummary(),
      undefined,
      readOptions,
    );

    let isRefunded = false;
    let addresses = [];

    if (currentUserAddress) {
      try {
        const userStatus = await readOnlyCall(
          ({ campaign }) =>
            campaign(address).methods.getUserAuctionStatus(currentUserAddress),
          undefined,
          readOptions,
        );
        const userParticipated = Boolean(userStatus[0]);
        isRefunded = Boolean(userStatus[2]);
        addresses = userParticipated ? [currentUserAddress] : [];
      } catch (error) {
        console.warn("User auction status read failed:", address, error);
      }
    }

    return normalizeAuction({
      address,
      listOrder,
      minimumContribution: details[0],
      balance: details[1],
      approversCount: details[2],
      manager: details[3],
      highestBid: details[4],
      dataForSell: "",
      dataDescription: details[5],
      highestBidder: details[6],
      addresses,
      endTime: Number(details[7]) * 1000,
      isRefunded,
      closed: details[8],
    });
  } catch (error) {
    if (isRpcRateLimitError(error)) {
      markAuctionReadRateLimited();
      throw error;
    }

    const details = await readOnlyCall(
      ({ campaign }) => campaign(address).methods.getSummary(),
      undefined,
      readOptions,
    );
    const addresses = details[8];
    const auctionEnded = Number(details[9]) * 1000 < Date.now();
    const closed = auctionEnded
      ? await readOnlyCall(
          ({ campaign }) => campaign(address).methods.getStatus(),
          undefined,
          readOptions,
        )
      : false;

    let isRefunded = false;
    const isHighestBidder =
      currentUserAddress && details[7].toLowerCase() === currentUserAddress;
    const isManager =
      currentUserAddress && details[3].toLowerCase() === currentUserAddress;
    const userInAuction =
      currentUserAddress &&
      addresses.some((address) => address.toLowerCase() === currentUserAddress);

    if (userInAuction && auctionEnded && !isHighestBidder && !isManager) {
      const balance = await readOnlyCall(
        ({ campaign }) => campaign(address).methods.getBid(currentUserAddress),
        undefined,
        readOptions,
      );
      isRefunded = Number(balance) === 0;
    }

    return normalizeAuction({
      address,
      listOrder,
      minimumContribution: details[0],
      balance: details[1],
      approversCount: details[2],
      manager: details[3],
      highestBid: details[4],
      dataForSell: details[5],
      dataDescription: details[6],
      highestBidder: details[7],
      addresses,
      endTime: Number(details[9]) * 1000,
      isRefunded,
      closed,
    });
  }
};

const mapSummaryResultToAuction = (result, address, listOrder) => {
  if (!result || result.status !== "fulfilled") return null;

  const details = result.value;

  return normalizeAuction({
    address,
    listOrder,
    minimumContribution: details[0],
    balance: details[1],
    approversCount: details[2],
    manager: details[3],
    highestBid: details[4],
    dataForSell: "",
    dataDescription: details[5],
    highestBidder: details[6],
    addresses: [],
    endTime: Number(details[7]) * 1000,
    isRefunded: false,
    closed: details[8],
  });
};

const readLightAuctionsFromChain = async (
  visibleAuctions,
  firstVisibleIndex,
  onProgress,
  factoryAddress,
) => {
  const summaryResults = [];
  const chunks = [];

  for (
    let offset = 0;
    offset < visibleAuctions.length;
    offset += BATCH_READ_SIZE
  ) {
    chunks.push({
      offset,
      addresses: visibleAuctions.slice(offset, offset + BATCH_READ_SIZE),
    });
  }

  const newestFirstChunks = chunks.reverse();
  const readChunk = async ({ offset, addresses }) => {
    if (isAuctionReadCoolingDown()) {
      return {
        offset,
        results: addresses.map(() => ({
          status: "rejected",
          reason: new Error("RPC read cooldown active"),
        })),
      };
    }

    try {
      const results = await readOnlyBatchCall(
        ({ campaign }) =>
          addresses.map((address) =>
            campaign(address).methods.getListSummary(),
          ),
        undefined,
        { preferInjected: false, allowInjectedFallback: false },
      );

      return { offset, results };
    } catch (error) {
      if (isRpcRateLimitError(error)) {
        markAuctionReadRateLimited();
      }

      console.warn("Auction summary batch failed:", error);
      return {
        offset,
        results: addresses.map(() => ({ status: "rejected", reason: error })),
      };
    }
  };
  const applyChunkRead = ({ offset, results }) => {
    results.forEach((result, chunkIndex) => {
      summaryResults[offset + chunkIndex] = result;
    });

    onProgress?.(
      summaryResults.map((result, index) =>
        mapSummaryResultToAuction(
          result,
          visibleAuctions[index],
          firstVisibleIndex + index,
        ),
      ),
    );
  };

  const [latestChunk, ...olderChunks] = newestFirstChunks;

  if (latestChunk) {
    applyChunkRead(await readChunk(latestChunk));
  }

  const olderChunkReads = await mapWithConcurrency(
    olderChunks,
    BATCH_READ_CONCURRENCY,
    readChunk,
  );

  olderChunkReads.forEach(applyChunkRead);

  return summaryResults.map((result, index) =>
    mapSummaryResultToAuction(
      result,
      visibleAuctions[index],
      firstVisibleIndex + index,
    ),
  );
};

const readAuctionsFromChain = async (
  visibleAuctionCount,
  onProgress,
  factoryAddress = getActiveFactoryAddress(),
) => {
  const auctions = await getDeployedCampaigns(factoryAddress);
  const firstVisibleIndex = Math.max(0, auctions.length - visibleAuctionCount);
  const visibleAuctions = auctions.slice(firstVisibleIndex);
  const publishProgress = (partialAuctionData) => {
    const stableAuctionData = mergeReadAuctionsWithCache(
      visibleAuctions,
      firstVisibleIndex,
      partialAuctionData,
      factoryAddress,
    );

    onProgress?.(
      cacheAuctionList({
        data: stableAuctionData,
        total: auctions.length,
        visibleCount: visibleAuctions.length,
        updatedAt: Date.now(),
        factoryAddress,
      }),
    );
  };

  let auctionData;

  try {
    auctionData = await readLightAuctionsFromChain(
      visibleAuctions,
      firstVisibleIndex,
      publishProgress,
      factoryAddress,
    );

    const missingIndexes = auctionData
      .map((auction, index) => (auction ? null : index))
      .filter((index) => index !== null);

    if (missingIndexes.length && !isAuctionReadCoolingDown()) {
      const fallbackAuctions = await mapWithConcurrency(
        [...missingIndexes].sort((a, b) => b - a),
        FETCH_CONCURRENCY,
        async (index) => {
          const address = visibleAuctions[index];

          try {
            return {
              index,
              auction: await readAuctionFromChain(
                address,
                "",
                firstVisibleIndex + index,
                {
                  preferInjected: false,
                  allowInjectedFallback: false,
                  factoryAddress,
                },
              ),
            };
          } catch (error) {
            if (isRpcRateLimitError(error)) {
              markAuctionReadRateLimited();
            } else {
              console.warn(
                "Skipping auction after RPC read failed:",
                address,
                error,
              );
            }
            return { index, auction: null };
          }
        },
      );

      fallbackAuctions.forEach(({ index, auction }) => {
        auctionData[index] = auction;
      });

      publishProgress(auctionData);
    }
  } catch (error) {
    if (isRpcRateLimitError(error)) {
      markAuctionReadRateLimited();
      auctionData = [];
    } else {
      console.warn("Batched auction read failed, falling back:", error);
      auctionData = await mapWithConcurrency(
        visibleAuctions.map((address, index) => ({ address, index })).reverse(),
        FETCH_CONCURRENCY,
        async ({ address, index }) => {
          try {
            return await readAuctionFromChain(
              address,
              "",
              firstVisibleIndex + index,
              {
                preferInjected: false,
                allowInjectedFallback: false,
                factoryAddress,
              },
            );
          } catch (readError) {
            if (isRpcRateLimitError(readError)) {
              markAuctionReadRateLimited();
            } else {
              console.warn(
                "Skipping auction after RPC read failed:",
                address,
                readError,
              );
            }
            return null;
          }
        },
      );
      auctionData = auctionData.reverse();
    }
  }

  const stableAuctionData = mergeReadAuctionsWithCache(
    visibleAuctions,
    firstVisibleIndex,
    auctionData,
    factoryAddress,
  );

  return cacheAuctionList({
    data: stableAuctionData,
    total: auctions.length,
    visibleCount: visibleAuctions.length,
    updatedAt: Date.now(),
    factoryAddress,
  });
};

const getUserStatusCacheKey = (factoryAddress, auctionAddress, userAddress) =>
  `${normalizeFactoryAddress(factoryAddress)}:${userAddress.toLowerCase()}:${auctionAddress.toLowerCase()}`;

const applyUserStatusesToAuctions = (auctions, statuses, userAddress) => {
  let changed = false;
  const normalizedUserAddress = userAddress.toLowerCase();

  const nextAuctions = auctions.map((auction) => {
    const status = statuses.get(auction.address.toLowerCase());
    if (!status) return auction;

    const nextAddresses = status.participated ? [normalizedUserAddress] : [];

    if (
      auction.isRefunded === status.isRefunded &&
      auction.addresses.length === nextAddresses.length &&
      auction.addresses[0]?.toLowerCase() === nextAddresses[0]
    ) {
      return auction;
    }

    changed = true;
    return {
      ...auction,
      addresses: nextAddresses,
      isRefunded: status.isRefunded,
    };
  });

  return { changed, auctions: changed ? nextAuctions : auctions };
};

const readUserStatusesForAuctions = async (
  auctions,
  userAddress,
  factoryAddress = getActiveFactoryAddress(),
) => {
  if (!userAddress || !auctions.length) return new Map();

  const userKey = userAddress.toLowerCase();
  const now = Date.now();
  const statuses = new Map();
  const misses = [];

  auctions.forEach((auction) => {
    const addressKey = auction.address.toLowerCase();
    const cacheKey = getUserStatusCacheKey(factoryAddress, addressKey, userKey);
    const cached = userAuctionStatusCache.get(cacheKey);

    if (cached && now - cached.updatedAt < USER_STATUS_TTL_MS) {
      statuses.set(addressKey, cached.value);
      return;
    }

    misses.push(auction);
  });

  if (!misses.length) return statuses;
  if (isAuctionReadCoolingDown()) return statuses;

  if (userAuctionStatusInFlight) {
    await userAuctionStatusInFlight.catch(() => {});
    return readUserStatusesForAuctions(auctions, userAddress, factoryAddress);
  }

  userAuctionStatusInFlight = readOnlyBatchCall(
    ({ campaign }) =>
      misses.map((auction) =>
        campaign(auction.address).methods.getUserAuctionStatus(userAddress),
      ),
    undefined,
    { preferInjected: false, allowInjectedFallback: false },
  ).finally(() => {
    userAuctionStatusInFlight = null;
  });

  const results = await userAuctionStatusInFlight;

  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;

    const auction = misses[index];
    const addressKey = auction.address.toLowerCase();
    const participated = Boolean(result.value[0]);
    const bid = Number(result.value[1] || 0);
    const isHighestBidder = Boolean(result.value[4]);
    const auctionClosed =
      Boolean(auction.closed) || Number(auction.endTime) <= Date.now();
    const isRefunded =
      Boolean(result.value[2]) ||
      (auctionClosed && participated && !isHighestBidder && bid === 0);
    const value = {
      participated,
      isRefunded,
    };

    userAuctionStatusCache.set(
      getUserStatusCacheKey(factoryAddress, addressKey, userKey),
      {
        value,
        updatedAt: Date.now(),
      },
    );
    statuses.set(addressKey, value);
  });

  return statuses;
};

function AuctionsListPage() {
  const navigate = useNavigate();
  const { state: navState } = useLocation();
  const [auctionsList, setAuctionsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [networkSlow, setNetworkSlow] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState("normal");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [now, setNow] = useState(Date.now());
  const [lastUpdated, setLastUpdated] = useState(
    auctionListCache.updatedAt || null,
  );
  const [connectedAccount, setConnectedAccount] = useState(
    window.ethereum?.selectedAddress?.toLowerCase() || "",
  );
  const [visibleAuctionCount, setVisibleAuctionCount] =
    useState(AUCTIONS_PAGE_SIZE);
  const [totalAuctionCount, setTotalAuctionCount] = useState(0);
  const [activeFactoryAddress, setActiveFactoryAddress] = useState(
    getActiveFactoryAddress(),
  );
  const fetchAuctionsListRef = useRef(null);
  const isFetchingRef = useRef(false);
  const pendingFetchRef = useRef(false);
  const requestIdRef = useRef(0);
  const activeFetchIdRef = useRef(0);
  const activeFetchKeyRef = useRef("");
  const activeFactoryAddressRef = useRef(getActiveFactoryAddress());
  const visibleAuctionCountRef = useRef(AUCTIONS_PAGE_SIZE);
  const didMountVisibleCountRef = useRef(false);
  const eventRefreshTimerRef = useRef(null);
  const lastEventRefreshRef = useRef(0);

  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || Infinity,
  );
  const currentUserAddress = connectedAccount;
  const searchIsActive = Boolean(searchQuery.trim());
  const statusTickIntervalMs = useMemo(() => {
    let hasActiveAuction = false;
    let hasNearEndingAuction = false;

    for (const auction of auctionsList) {
      if (auction.isReadPlaceholder) continue;

      const endsInMs = Number(auction.endTime) - now;
      if (Number.isNaN(endsInMs) || endsInMs <= 0 || auction.closed) {
        continue;
      }

      hasActiveAuction = true;
      if (endsInMs <= FAST_STATUS_TICK_WINDOW_MS) {
        hasNearEndingAuction = true;
        break;
      }
    }

    if (hasNearEndingAuction) return STATUS_TICK_FAST_MS;
    if (hasActiveAuction) return STATUS_TICK_BASE_MS;
    return STATUS_TICK_IDLE_MS;
  }, [auctionsList, now]);

  const loadRemainingBudget = useCallback(async (account) => {
    const factoryAddressForRequest = activeFactoryAddressRef.current;

    try {
      const budget = await getRemainingBudget(
        account,
        factoryAddressForRequest,
      );
      if (
        normalizeFactoryAddress(factoryAddressForRequest) !==
        normalizeFactoryAddress(activeFactoryAddressRef.current)
      ) {
        return;
      }

      const isUnlimited =
        budget === 0 ||
        budget === "0" ||
        budget === null ||
        budget === undefined;
      setRemainingBudget(isUnlimited ? Infinity : budget);
    } catch (error) {
      console.error("Error loading remaining budget:", error);
    }
  }, []);

  const keepNormalAuctionOrder = useCallback((nextAuctions, limit) => {
    return sortByMarketOrder(nextAuctions || []).slice(0, limit);
  }, []);

  const fetchAuctionsList = useCallback(async () => {
    const visibleCountForRequest = visibleAuctionCount;
    const factoryAddressForRequest = activeFactoryAddressRef.current;
    const normalizedRequestFactory = normalizeFactoryAddress(
      factoryAddressForRequest,
    );
    const cached = getCachedAuctions(
      visibleAuctionCount,
      factoryAddressForRequest,
    );
    const shouldShowBackgroundRefresh =
      !loading && !loadingMore && !document.hidden;
    const isCurrentRequest = (requestId) =>
      requestId === requestIdRef.current &&
      visibleCountForRequest === visibleAuctionCountRef.current &&
      normalizedRequestFactory ===
        normalizeFactoryAddress(activeFactoryAddressRef.current);

    if (cached) {
      setAuctionsList(
        keepNormalAuctionOrder(cached.data, visibleCountForRequest),
      );
      setTotalAuctionCount(cached.total);
      setLastUpdated(cached.updatedAt);
      setLoading(false);
      setLoadingMore(false);

      if (cached.fresh) {
        setRefreshing(false);
        return;
      }

      if (!document.hidden) {
        setRefreshing(true);
      }
    }

    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
    const requestKey = [
      AUCTIONS_API_URL || "chain",
      normalizedRequestFactory,
      visibleCountForRequest,
      AUCTIONS_API_URL ? currentUserAddress || "" : "market",
    ].join(":");

    if (isFetchingRef.current && activeFetchKeyRef.current === requestKey) {
      pendingFetchRef.current = true;
      return;
    }

    isFetchingRef.current = true;
    activeFetchKeyRef.current = requestKey;
    if (shouldShowBackgroundRefresh) {
      setRefreshing(true);
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    activeFetchIdRef.current = requestId;

    try {
      if (!auctionListInFlight || auctionListInFlight.key !== requestKey) {
        const promise = (async () => {
          if (AUCTIONS_API_URL) {
            try {
              return await readAuctionsFromApi(
                visibleCountForRequest,
                currentUserAddress,
                factoryAddressForRequest,
              );
            } catch (apiError) {
              console.warn(
                "Auction API unavailable, falling back to chain:",
                apiError,
              );
            }
          }

          return readAuctionsFromChain(
            visibleCountForRequest,
            (snapshot) => {
              if (isCurrentRequest(requestId)) {
                setAuctionsList(
                  keepNormalAuctionOrder(snapshot.data, visibleCountForRequest),
                );
                setTotalAuctionCount(snapshot.total);
                setLastUpdated(snapshot.updatedAt);
                setLoading(false);
                setNetworkSlow(false);
              }
            },
            factoryAddressForRequest,
          );
        })().finally(() => {
          if (auctionListInFlight?.key === requestKey) {
            auctionListInFlight = null;
          }
        });

        auctionListInFlight = { key: requestKey, promise };
      }

      const { data, total } = await auctionListInFlight.promise;

      if (isCurrentRequest(requestId)) {
        setAuctionsList(keepNormalAuctionOrder(data, visibleCountForRequest));
        setTotalAuctionCount(total);
        setLastUpdated(Date.now());
        setNetworkSlow(false);
      }
    } catch (error) {
      const stale = getCachedAuctions(
        visibleAuctionCount,
        factoryAddressForRequest,
      );
      if (stale && isCurrentRequest(requestId)) {
        setAuctionsList(
          keepNormalAuctionOrder(stale.data, visibleCountForRequest),
        );
        setTotalAuctionCount(stale.total);
        setLastUpdated(stale.updatedAt);
      }
      if (isCurrentRequest(requestId)) {
        setNetworkSlow(true);
      }
      console.error("Error fetching auctions:", error);
    } finally {
      if (activeFetchIdRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
        isFetchingRef.current = false;
        activeFetchKeyRef.current = "";
        if (pendingFetchRef.current) {
          pendingFetchRef.current = false;
          window.setTimeout(() => fetchAuctionsListRef.current?.(), 0);
        }
      }
    }
  }, [keepNormalAuctionOrder, loading, loadingMore, visibleAuctionCount]);

  useEffect(() => {
    fetchAuctionsListRef.current = fetchAuctionsList;
  }, [fetchAuctionsList]);

  useEffect(() => {
    return subscribeToMarketChanges((_market, meta = {}) => {
      if (meta.reason === "label") return;

      const nextFactoryAddress = getActiveFactoryAddress();
      activeFactoryAddressRef.current = nextFactoryAddress;
      requestIdRef.current += 1;
      activeFetchKeyRef.current = "";
      pendingFetchRef.current = false;
      invalidateAuctionCaches();
      setActiveFactoryAddress(nextFactoryAddress);
      setAuctionsList([]);
      setTotalAuctionCount(0);
      setVisibleAuctionCount(AUCTIONS_PAGE_SIZE);
      setLastUpdated(null);
      setLoading(true);
      setRefreshing(false);
      setNetworkSlow(false);
      window.setTimeout(() => fetchAuctionsListRef.current?.(), 0);
    });
  }, []);

  useEffect(() => {
    visibleAuctionCountRef.current = visibleAuctionCount;
  }, [visibleAuctionCount]);

  const scheduleEventRefresh = useCallback(() => {
    if (document.hidden) return;

    const elapsed = Date.now() - lastEventRefreshRef.current;
    const delay = Math.max(EVENT_REFRESH_DELAY_MS - elapsed, 250);

    window.clearTimeout(eventRefreshTimerRef.current);
    eventRefreshTimerRef.current = window.setTimeout(() => {
      lastEventRefreshRef.current = Date.now();
      requestIdRef.current += 1;
      invalidateAuctionCaches();
      fetchAuctionsListRef.current?.();
    }, delay);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, statusTickIntervalMs);
    const handleVisibilityChange = () => {
      if (!document.hidden) setNow(Date.now());
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [statusTickIntervalMs]);

  useEffect(() => {
    if (!didMountVisibleCountRef.current) {
      didMountVisibleCountRef.current = true;
      return;
    }

    fetchAuctionsListRef.current?.();
  }, [visibleAuctionCount]);

  useEffect(() => {
    if (!window.ethereum) {
      navigate("/");
      return undefined;
    }

    const setAccount = (accounts) => {
      const nextAccount =
        accounts?.[0]?.toLowerCase() ||
        window.ethereum?.selectedAddress?.toLowerCase() ||
        null;
      setConnectedAccount(nextAccount || "");
      if (nextAccount) {
        loadRemainingBudget(nextAccount);
      }
    };

    window.ethereum
      .request({ method: "eth_accounts" })
      .then(setAccount)
      .catch((error) => console.error("Error reading accounts:", error));

    fetchAuctionsListRef.current?.();

    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchAuctionsListRef.current?.();
    }, POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        fetchAuctionsListRef.current?.();
      }
    };

    window.ethereum.on?.("accountsChanged", setAccount);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.ethereum.removeListener?.("accountsChanged", setAccount);
    };
  }, [navigate, loadRemainingBudget]);

  useEffect(() => {
    if (!currentUserAddress || !auctionsList.length) return undefined;

    let cancelled = false;
    const factoryAddressForRequest = activeFactoryAddressRef.current;
    const visibleAuctions = auctionsList
      .slice(0, visibleAuctionCount)
      .filter((auction) => !auction.isReadPlaceholder);

    readUserStatusesForAuctions(
      visibleAuctions,
      currentUserAddress,
      factoryAddressForRequest,
    )
      .then((statuses) => {
        if (
          cancelled ||
          !statuses.size ||
          normalizeFactoryAddress(factoryAddressForRequest) !==
            normalizeFactoryAddress(activeFactoryAddressRef.current)
        ) {
          return;
        }

        setAuctionsList((currentAuctions) => {
          if (
            normalizeFactoryAddress(factoryAddressForRequest) !==
            normalizeFactoryAddress(activeFactoryAddressRef.current)
          ) {
            return currentAuctions;
          }

          const result = applyUserStatusesToAuctions(
            currentAuctions,
            statuses,
            currentUserAddress,
          );

          return result.auctions;
        });
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("User auction status batch failed:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [auctionsList, currentUserAddress, visibleAuctionCount]);

  useEffect(() => {
    if (AUCTIONS_API_URL) return undefined;

    let createdEvent;

    try {
      createdEvent = factorySocket.events.AuctionCreated();
      createdEvent.on("data", scheduleEventRefresh);
      createdEvent.on("error", (error) =>
        console.warn("AuctionCreated subscription failed:", error),
      );
    } catch (error) {
      console.warn("Factory event subscriptions are unavailable:", error);
    }

    return () => {
      window.clearTimeout(eventRefreshTimerRef.current);
      createdEvent?.unsubscribe?.();
    };
  }, [activeFactoryAddress, scheduleEventRefresh]);

  const handleManualRefresh = useCallback(() => {
    requestIdRef.current += 1;
    invalidateAuctionCaches();
    setNetworkSlow(false);
    setRefreshing(true);
    fetchAuctionsListRef.current?.();
  }, []);

  const bidSubscriptionKey = useMemo(() => {
    const maxSubscriptions = shouldLimitLiveEventLoad()
      ? Math.min(2, MAX_LIVE_BID_SUBSCRIPTIONS)
      : MAX_LIVE_BID_SUBSCRIPTIONS;
    const currentTime = Date.now();

    return auctionsList
      .slice(0, Math.min(AUCTIONS_PAGE_SIZE, maxSubscriptions))
      .filter((auction) => Number(auction.endTime) > currentTime)
      .map((auction) => auction.address)
      .join("|");
  }, [auctionsList]);

  useEffect(() => {
    if (AUCTIONS_API_URL) return undefined;

    const bidEvents = [];
    const bidSubscriptionAddresses = bidSubscriptionKey
      ? bidSubscriptionKey.split("|")
      : [];

    try {
      bidSubscriptionAddresses.forEach((address) => {
        const bidEvent = campaignSocket(address).events.BidAdded();
        bidEvent.on("data", scheduleEventRefresh);
        bidEvent.on("error", (error) =>
          console.warn("Bid subscription failed:", address, error),
        );
        bidEvents.push(bidEvent);
      });
    } catch (error) {
      console.warn(
        "Visible auction event subscriptions are unavailable:",
        error,
      );
    }

    return () => {
      bidEvents.forEach((event) => event.unsubscribe?.());
    };
  }, [bidSubscriptionKey, scheduleEventRefresh]);

  const getTimeLeft = (endTime) => {
    if (!Number(endTime)) return "";

    const millisecondsLeft = Number(endTime) - now;
    if (millisecondsLeft <= 0) return "Closed";

    const totalSeconds = Math.max(0, Math.floor(millisecondsLeft / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, "0");

    if (days > 0) {
      return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  };

  const getAuctionDate = (endTime) => {
    const timestamp = Number(endTime);
    if (!timestamp) return "";

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getAuctionTime = (endTime) => {
    const timestamp = Number(endTime);
    if (!timestamp) return "";

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getLastUpdatedText = () => {
    if (!lastUpdated) return "Waiting for first sync";

    const secondsAgo = Math.max(0, Math.floor((now - Number(lastUpdated)) / 1000));

    if (secondsAgo < 5) return "Updated now";
    if (secondsAgo < 60) return `Updated ${secondsAgo}s ago`;

    const minutesAgo = Math.floor(secondsAgo / 60);
    return `Updated ${minutesAgo}m ago`;
  };

  const isAuctionOpen = (endTime) => {
    return Number(endTime) > now;
  };

  const isHighestBidder = (auction, currentUserAddress) => {
    return auction.highestBidder?.toLowerCase() === currentUserAddress;
  };

  const hasUserWonAuction = (auction, currentUserAddress) => {
    const auctionEnded = Number(auction.endTime) < now;
    const userIsHighestBidder = isHighestBidder(auction, currentUserAddress);
    return auctionEnded && userIsHighestBidder;
  };

  const isUserInAuction = (auction, currentUserAddress) => {
    return !!auction?.addresses?.some(
      (address) => address.toLowerCase() === currentUserAddress,
    );
  };

  const isUserManager = (auction, currentUserAddress) => {
    return (
      Boolean(currentUserAddress) &&
      currentUserAddress === auction.manager?.toLowerCase?.()
    );
  };

  const getRowStyles = (hasWon, isOpen, isRefunded) => ({
    backgroundColor: hasWon
      ? "#90EE90"
      : isOpen
        ? "#BBDEFB"
        : isRefunded
          ? "#FFD700"
          : "#E9E9F6",
    marginBottom: "1rem",
    transition: "background-color 65ms ease, box-shadow 85ms ease",
    "&:hover": {
      backgroundColor: hasWon
        ? "#77DD77"
        : isOpen
          ? "#A3CFFA"
          : isRefunded
            ? "#FFC107"
            : "#D0D0F0",
      cursor: "pointer",
    },
  });

  const getFontStyles = (auction, currentAddress, isOpen) => ({
    color:
      isHighestBidder(auction, currentAddress) && isAuctionOpen(auction.endTime)
        ? "#11a811ff"
        : isUserInAuction(auction, currentAddress) &&
            isAuctionOpen(auction.endTime) &&
            !isUserManager(auction, currentAddress)
          ? "#da0c0cff"
          : isOpen
            ? "#D07030D0"
            : "#0D0D4E",
  });

  const getRefundStatus = (auction, userParticipated, userWon, auctionOpen) => {
    if (auction.isReadPlaceholder) return "";

    const isManager = isUserManager(auction, currentUserAddress);

    if (userParticipated && !userWon && !auctionOpen) {
      return auction.isRefunded ? "Refunded" : "Awaiting Refund";
    }

    if (userWon) {
      return auctionOpen ? "" : "You were charged";
    }

    if (isManager && auction.approversCount > 0) {
      if (auctionOpen) return "";
      return auction.closed ? "You were paid" : "Payment pending";
    }

    return "";
  };

  const auctionSearchIndex = useMemo(() => {
    const rows = [];
    const tokenMap = new Map();
    const numberMap = new Map();
    const exactAddressMap = new Map();

    auctionsList.forEach((auction) => {
      const textFields = [
        auction.dataDescription,
        auction.dataForSell,
        getAuctionDate(auction.endTime),
        Number(auction.endTime) > Date.now() ? "open active" : "closed ended",
        auction.closed ? "closed ended" : "open active",
      ];
      const addressFields = [
        auction.address,
        auction.manager,
        auction.highestBidder,
        ...(auction.addresses || []),
      ];
      const numberFields = [
        auction.highestBid,
        auction.minimumContribution,
        auction.approversCount,
      ].map((value) => String(value ?? ""));
      const text = normalizeSearchText(textFields.join(" "));
      const address = normalizeAddressText(addressFields.join(" "));
      const numbers = new Set(numberFields);
      const row = { auction, text, address, numbers };

      rows.push(row);

      new Set(text.split(/\s+/).filter(Boolean)).forEach((token) => {
        if (!tokenMap.has(token)) tokenMap.set(token, []);
        tokenMap.get(token).push(row);
      });

      numbers.forEach((number) => {
        if (!number) return;
        if (!numberMap.has(number)) numberMap.set(number, []);
        numberMap.get(number).push(row);
      });

      addressFields.forEach((rawAddress) => {
        const normalizedAddress = normalizeAddressText(rawAddress);
        if (!normalizedAddress) return;
        if (!exactAddressMap.has(normalizedAddress)) {
          exactAddressMap.set(normalizedAddress, []);
        }
        exactAddressMap.get(normalizedAddress).push(row);
      });
    });

    return { rows, tokenMap, numberMap, exactAddressMap };
  }, [auctionsList]);

  const searchedAuctions = useMemo(() => {
    const query = getSearchKind(deferredSearchQuery);
    if (!query.value) return auctionsList;

    const orderedRows = auctionSearchIndex.rows;
    let candidateRows = orderedRows;

    if (query.kind === "number") {
      candidateRows = auctionSearchIndex.numberMap.get(query.value) || [];
    } else if (query.kind === "address") {
      candidateRows =
        auctionSearchIndex.exactAddressMap.get(query.value) || orderedRows;
    } else if (query.tokens.length) {
      const tokenCandidates = query.tokens
        .map((token) => auctionSearchIndex.tokenMap.get(token) || [])
        .sort((a, b) => a.length - b.length);

      if (tokenCandidates.length) {
        const allowed = new Set(
          tokenCandidates[0].map((row) => row.auction.address),
        );
        tokenCandidates.slice(1).forEach((rows) => {
          const rowAddresses = new Set(rows.map((row) => row.auction.address));
          Array.from(allowed).forEach((address) => {
            if (!rowAddresses.has(address)) allowed.delete(address);
          });
        });
        candidateRows = orderedRows.filter((row) =>
          allowed.has(row.auction.address),
        );
      }
    }

    return candidateRows
      .filter(({ text, address, numbers }) => {
        if (query.kind === "number") {
          return numbers.has(query.value);
        }

        if (query.kind === "address") {
          return address.includes(query.value);
        }

        return (
          text.includes(query.value) ||
          query.tokens.every((token) => text.includes(token))
        );
      })
      .map(({ auction }) => auction);
  }, [auctionSearchIndex, auctionsList, deferredSearchQuery]);

  const sortClock = sortMode === "ending" ? now : 0;
  const sortedAuctions = useMemo(() => {
    if (sortMode === "normal") return searchedAuctions;

    const sorted = [...searchedAuctions];

    sorted.sort((a, b) => {
      if (sortMode === "ending") {
        const aOpen = Number(a.endTime) > sortClock;
        const bOpen = Number(b.endTime) > sortClock;
        if (aOpen !== bOpen) return aOpen ? -1 : 1;
        return Number(a.endTime) - Number(b.endTime);
      }

      if (sortMode === "highest") {
        return Number(b.highestBid || 0) - Number(a.highestBid || 0);
      }

      if (sortMode === "bidders") {
        return Number(b.approversCount || 0) - Number(a.approversCount || 0);
      }

      return 0;
    });

    return sorted;
  }, [searchedAuctions, sortMode, sortClock]);

  const viewIsFiltered = Boolean(deferredSearchQuery.trim());
  const loadedAuctionCount = auctionsList.length;
  const visibleResultCount = sortedAuctions.length;

  const displayedAuctions = useMemo(() => {
    return searchIsActive
      ? sortedAuctions
      : sortedAuctions.slice(0, visibleAuctionCount);
  }, [sortedAuctions, searchIsActive, visibleAuctionCount]);

  const handleSearchChange = (event) => {
    setSearchQuery(event.target.value);
  };

  const clearSearch = () => {
    setSearchQuery("");
  };

  const loadMoreAuctions = () => {
    setLoadingMore(true);
    setVisibleAuctionCount((count) => {
      return count + AUCTIONS_PAGE_SIZE;
    });
  };

  const handleRowClick = (address, e) => {
    e.stopPropagation();
    navigate(`/auction/${address}`, { state: { remainingBudget } });
  };

  return (
    <Layout>
      <div className={styles.page}>
        <div className={styles.createAuction}>
          <div className={styles.introduction}>
            <div className={styles.introductionText}>
              <div className={styles.heroContent}>
                <img
                  className={styles.heroImage}
                  src={picSrc}
                  alt="Blockchain auction marketplace dashboard"
                />
                <div className={styles.heroCopy}>
                  <h1 className={styles.introductionTitle}>
                    Welcome to the Blockchain Data Market Platform
                  </h1>
                  <p className={styles.introductionSubtitle}>
                    Scroll down to see all the open and closed auctions.
                    <br />
                    Do you want to put your data for auction?
                  </p>
                  <Button
                    variant="contained"
                    style={{
                      backgroundColor: "rgb(16, 48, 144)",
                      color: "white",
                      borderRadius: "30px",
                      padding: "12px 22px",
                    }}
                    onClick={() => navigate("/open-auction")}
                  >
                    Start an auction
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loadingContainer}>
            <div className={styles.auctionLoader} aria-label="Loading auctions">
              <span />
              <span />
              <span />
            </div>
            <p className={styles.loadingTitle}>Finding the latest auctions</p>
            <p className={styles.loadingHint}>Newest listings appear first.</p>
          </div>
        ) : (
          <TableContainer
            component={Paper}
            className={styles.tableShell}
            style={{
              padding: "5px 20px",
              borderRadius: "20px",
              width: "100%",
            }}
          >
            <div className={styles.searchBar}>
              <TextField
                fullWidth
                className={styles.searchInput}
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder="Search auctions by description, wallet, address, or exact bid"
                variant="outlined"
                size="small"
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon className={styles.searchIcon} />
                    </InputAdornment>
                  ),
                  endAdornment: searchQuery ? (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="Clear search"
                        size="small"
                        onClick={clearSearch}
                        className={styles.clearSearchIcon}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                }}
              />
              {(refreshing || deferredSearchQuery !== searchQuery) && (
                <div className={styles.tableStatus}>
                  <span className={styles.syncDot} aria-hidden="true" />
                  <span>
                    {deferredSearchQuery !== searchQuery
                      ? "Filtering"
                      : "Updating"}
                  </span>
                </div>
              )}
            </div>
            <div className={styles.tableToolbar}>
              <div className={styles.tableTools}>
                <label className={styles.sortControl}>
                  <span>Sort</span>
                  <select
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value)}
                  >
                    {SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="outlined"
                  size="small"
                  className={styles.refreshButton}
                  onClick={handleManualRefresh}
                  disabled={refreshing}
                >
                  {refreshing ? "Refreshing" : "Refresh"}
                </Button>
              </div>
            </div>
            <div className={styles.listMeta} aria-live="polite">
              <span>
                {viewIsFiltered
                  ? `Showing ${displayedAuctions.length} of ${visibleResultCount} matches from ${loadedAuctionCount} loaded auctions`
                  : `Showing ${displayedAuctions.length} of ${totalAuctionCount} auctions`}
              </span>
              <span className={networkSlow ? styles.networkWarning : ""}>
                {networkSlow
                  ? "Network slow: showing saved data"
                  : getLastUpdatedText()}
              </span>
            </div>
            <Table aria-label="auctions table" className={styles.auctionsTable}>
              <TableHead>
                <TableRow>
                  {[
                    "Description",
                    "End Date",
                    "Auction Status",
                    "Highest Bid",
                    "Number Of Bidders",
                    "Payment Status",
                    "",
                  ].map((title, idx) => (
                    <TableCell
                      key={idx}
                      align={"center"}
                      style={{ color: "#0d0d4eff", fontWeight: "bold" }}
                    >
                      {title}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {displayedAuctions.map((auction, index) => {
                  const userWon = hasUserWonAuction(
                    auction,
                    currentUserAddress,
                  );
                  const userParticipated = isUserInAuction(
                    auction,
                    currentUserAddress,
                  );
                  const auctionOpen = isAuctionOpen(auction.endTime);

                  return (
                    <TableRow
                      key={auction.address}
                      onClick={() =>
                        navigate(`/auction/${auction.address}`, {
                          state: { remainingBudget },
                        })
                      }
                      sx={getRowStyles(
                        userWon,
                        auctionOpen,
                        auction.isRefunded,
                      )}
                    >
                      <TableCell
                        sx={getFontStyles(auction, currentUserAddress)}
                        align="center"
                      >
                        {auction.isReadPlaceholder ? (
                          <LoadingAuctionLabel />
                        ) : (
                          auction.dataDescription
                        )}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentUserAddress)}
                      >
                        <span className={styles.dateCell}>
                          <span>{getAuctionDate(auction.endTime)}</span>
                          <small>{getAuctionTime(auction.endTime)}</small>
                        </span>
                      </TableCell>

                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentUserAddress, true)}
                        style={{ fontWeight: "bold" }}
                      >
                        {getTimeLeft(auction.endTime)}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentUserAddress)}
                      >
                        {auction.isReadPlaceholder ? "" : auction.highestBid}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentUserAddress)}
                      >
                        {auction.isReadPlaceholder
                          ? ""
                          : auction.approversCount}
                      </TableCell>
                      <TableCell
                        sx={getFontStyles(auction, currentUserAddress)}
                        align="center"
                      >
                        {getRefundStatus(
                          auction,
                          userParticipated,
                          userWon,
                          auctionOpen,
                        )}
                      </TableCell>
                      <TableCell align="center">
                        <Button
                          variant="contained"
                          className={userWon ? styles.viewDataButton : ""}
                          style={{
                            backgroundColor: userWon
                              ? undefined
                              : auction.isRefunded
                                ? "#FFD700"
                                : "#9090D0",
                            color: userWon ? undefined : "white",
                            borderRadius: "20px",
                            padding: "6px 20px",
                            textTransform: "uppercase",
                            fontSize: "0.875rem",
                            width: "max-content",
                          }}
                          onClick={(e) => handleRowClick(auction.address, e)}
                        >
                          {userWon ? "View Data" : "View Auction"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {viewIsFiltered && !sortedAuctions.length && (
              <div className={styles.emptySearch}>
                No auctions match your search.
              </div>
            )}
            {visibleAuctionCount < totalAuctionCount && (
              <div className={styles.loadMoreWrap}>
                <Button
                  variant="contained"
                  className={styles.loadMoreButton}
                  style={{
                    backgroundColor: "#103090",
                    color: "white",
                    borderRadius: "20px",
                    padding: "8px 24px",
                    minWidth: "180px",
                  }}
                  onClick={loadMoreAuctions}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <CircularProgress size={20} style={{ color: "white" }} />
                  ) : (
                    "Load More Auctions"
                  )}
                </Button>
              </div>
            )}
          </TableContainer>
        )}
      </div>
    </Layout>
  );
}

export default AuctionsListPage;
