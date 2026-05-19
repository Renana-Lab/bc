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
import { campaignSocket, factorySocket } from "../../real_ethereum/socketFactory";
import Layout from "../../components/Layout";
import styles from "./auctions.module.scss";
import picSrc from "./Illustration_Start.png";

const AUCTIONS_PAGE_SIZE = 20;
const FETCH_CONCURRENCY = 5;
const POLL_INTERVAL_MS = 10000;
const COUNTDOWN_TICK_MS = 1000;
const EVENT_REFRESH_DELAY_MS = 900;
const CACHE_TTL_MS = 6000;
const DEPLOYED_CAMPAIGNS_TTL_MS = 60000;
const USER_STATUS_TTL_MS = 8000;
const LOCAL_AUCTIONS_CACHE_KEY = "data-market:auctions:v2";
const LOCAL_AUCTIONS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const AUCTIONS_API_URL = (process.env.REACT_APP_AUCTION_API_URL || "").replace(
  /\/$/,
  ""
);

const SORT_OPTIONS = [
  { value: "normal", label: "Market order" },
  { value: "ending", label: "Ending soon" },
  { value: "highest", label: "Highest bid" },
  { value: "bidders", label: "Most bidders" },
];

let auctionListCache = {
  data: [],
  total: 0,
  visibleCount: 0,
  updatedAt: 0,
};
let deployedCampaignsCache = {
  data: [],
  updatedAt: 0,
};
let auctionListInFlight = null;
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
});

const readStoredAuctionListCache = () => {
  if (typeof window === "undefined" || !window.localStorage) return null;

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(LOCAL_AUCTIONS_CACHE_KEY) || "null"
    );

    if (
      !stored?.data?.length ||
      Date.now() - Number(stored.updatedAt || 0) > LOCAL_AUCTIONS_CACHE_MAX_AGE_MS
    ) {
      return null;
    }

    return {
      data: sortNewestFirst(stored.data.map(normalizeAuction)),
      total: Number(stored.total || stored.data.length),
      visibleCount: Number(stored.visibleCount || stored.data.length),
      updatedAt: Number(stored.updatedAt || Date.now()),
    };
  } catch (error) {
    return null;
  }
};

const writeStoredAuctionListCache = (cache) => {
  if (typeof window === "undefined" || !window.localStorage) return;

  try {
    window.localStorage.setItem(
      LOCAL_AUCTIONS_CACHE_KEY,
      JSON.stringify({
        data: cache.data.slice(0, 100),
        total: cache.total,
        visibleCount: cache.visibleCount,
        updatedAt: cache.updatedAt,
      })
    );
  } catch (error) {
    // Storage is best-effort; the live chain read is still the source of truth.
  }
};

const sortNewestFirst = (auctions) =>
  [...auctions].sort((a, b) => {
    if (b.listOrder !== a.listOrder) return b.listOrder - a.listOrder;
    return String(b.address).localeCompare(String(a.address));
  });

const cacheAuctionList = ({ data, total, visibleCount, updatedAt }) => {
  const orderedData = sortNewestFirst(data || []);

  auctionListCache = {
    data: orderedData,
    total: Number(total ?? orderedData.length),
    visibleCount: Number(visibleCount ?? orderedData.length),
    updatedAt: updatedAt || Date.now(),
  };

  writeStoredAuctionListCache(auctionListCache);
  return auctionListCache;
};

const invalidateAuctionCaches = () => {
  auctionListCache.updatedAt = 0;
  deployedCampaignsCache.updatedAt = 0;
};

const getDeployedCampaigns = async () => {
  if (
    deployedCampaignsCache.data.length &&
    Date.now() - deployedCampaignsCache.updatedAt < DEPLOYED_CAMPAIGNS_TTL_MS
  ) {
    return deployedCampaignsCache.data;
  }

  const data = await readOnlyCall(({ factory }) =>
    factory.methods.getDeployedCampaigns()
  );

  deployedCampaignsCache = {
    data,
    updatedAt: Date.now(),
  };

  return data;
};

export const getRemainingBudget = async (userAddress) => {
  if (!window.ethereum) return null;

  const accounts = userAddress
    ? [userAddress]
    : await window.ethereum.request({ method: "eth_accounts" });
  const account = accounts?.[0];

  if (!account) return null;

  const normalizedAccount = account.toLowerCase();
  const cached = budgetCache.get(normalizedAccount);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.budget;
  }

  if (budgetInFlight.has(normalizedAccount)) {
    return budgetInFlight.get(normalizedAccount);
  }

  const request = readOnlyCall(({ factory }) => factory.methods.getBudget(account))
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
    }
  );

  await Promise.all(workers);
  return results;
};

const getCachedAuctions = (visibleAuctionCount) => {
  if (!auctionListCache.data.length) {
    const stored = readStoredAuctionListCache();
    if (stored) auctionListCache = stored;
  }

  if (
    auctionListCache.data.length &&
    auctionListCache.visibleCount >= visibleAuctionCount
  ) {
    const orderedData = sortNewestFirst(auctionListCache.data);

    return {
      data: orderedData.slice(0, visibleAuctionCount),
      total: auctionListCache.total,
      fresh: Date.now() - auctionListCache.updatedAt < CACHE_TTL_MS,
    };
  }

  return null;
};

const readAuctionsFromApi = async (visibleAuctionCount, currentUserAddress) => {
  if (!AUCTIONS_API_URL) return null;

  const params = new URLSearchParams({ limit: String(visibleAuctionCount) });
  if (currentUserAddress) params.set("user", currentUserAddress);

  const response = await fetch(`${AUCTIONS_API_URL}/auctions?${params}`);
  if (!response.ok) {
    throw new Error(`Auction API failed with status ${response.status}`);
  }

  const payload = await response.json();
  const auctions = payload.data || payload.auctions || [];
  const total = Number(payload.total ?? payload.count ?? auctions.length);
  const firstVisibleIndex = Math.max(0, total - auctions.length);
  const data = auctions.map((auction, index) =>
    normalizeAuction({
      ...auction,
      listOrder: auction.listOrder ?? firstVisibleIndex + index,
    })
  );

  return cacheAuctionList({
    data,
    total,
    visibleCount: visibleAuctionCount,
    updatedAt: Date.now(),
  });
};

const readAuctionFromChain = async (address, currentUserAddress, listOrder = 0) => {
  try {
    const details = await readOnlyCall(({ campaign }) =>
      campaign(address).methods.getListSummary()
    );

    let isRefunded = false;
    let addresses = [];

    if (currentUserAddress) {
      try {
        const userStatus = await readOnlyCall(({ campaign }) =>
          campaign(address).methods.getUserAuctionStatus(currentUserAddress)
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
    const details = await readOnlyCall(({ campaign }) =>
      campaign(address).methods.getSummary()
    );
    const addresses = details[8];
    const auctionEnded = Number(details[9]) * 1000 < Date.now();
    const closed = auctionEnded
      ? await readOnlyCall(({ campaign }) => campaign(address).methods.getStatus())
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
      const balance = await readOnlyCall(({ campaign }) =>
        campaign(address).methods.getBid(currentUserAddress)
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

const readLightAuctionsFromChain = async (
  visibleAuctions,
  firstVisibleIndex
) => {
  const summaryResults = await readOnlyBatchCall(({ campaign }) =>
    visibleAuctions.map((address) => campaign(address).methods.getListSummary())
  );

  return summaryResults.map((result, index) => {
    if (result.status !== "fulfilled") return null;

    const address = visibleAuctions[index];
    const details = result.value;

    return normalizeAuction({
      address,
      listOrder: firstVisibleIndex + index,
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
  });
};

const readAuctionsFromChain = async (visibleAuctionCount) => {
  const auctions = await getDeployedCampaigns();
  const firstVisibleIndex = Math.max(0, auctions.length - visibleAuctionCount);
  const visibleAuctions = auctions.slice(firstVisibleIndex);

  let auctionData;

  try {
    auctionData = await readLightAuctionsFromChain(
      visibleAuctions,
      firstVisibleIndex
    );

    const missingIndexes = auctionData
      .map((auction, index) => (auction ? null : index))
      .filter((index) => index !== null);

    if (missingIndexes.length) {
      const fallbackAuctions = await mapWithConcurrency(
        missingIndexes,
        FETCH_CONCURRENCY,
        async (index) => {
          const address = visibleAuctions[index];

          try {
            return {
              index,
              auction: await readAuctionFromChain(
                address,
                "",
                firstVisibleIndex + index
              ),
            };
          } catch (error) {
            console.warn("Skipping auction after RPC read failed:", address, error);
            return { index, auction: null };
          }
        }
      );

      fallbackAuctions.forEach(({ index, auction }) => {
        auctionData[index] = auction;
      });
    }
  } catch (error) {
    console.warn("Batched auction read failed, falling back:", error);
    auctionData = await mapWithConcurrency(
      visibleAuctions,
      FETCH_CONCURRENCY,
      async (address, index) => {
        try {
          return await readAuctionFromChain(
            address,
            "",
            firstVisibleIndex + index
          );
        } catch (readError) {
          console.warn("Skipping auction after RPC read failed:", address, readError);
          return null;
        }
      }
    );
  }

  return cacheAuctionList({
    data: auctionData.filter(Boolean),
    total: auctions.length,
    visibleCount: visibleAuctionCount,
    updatedAt: Date.now(),
  });
};

const getUserStatusCacheKey = (auctionAddress, userAddress) =>
  `${userAddress.toLowerCase()}:${auctionAddress.toLowerCase()}`;

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

const readUserStatusesForAuctions = async (auctions, userAddress) => {
  if (!userAddress || !auctions.length) return new Map();

  const userKey = userAddress.toLowerCase();
  const now = Date.now();
  const statuses = new Map();
  const misses = [];

  auctions.forEach((auction) => {
    const addressKey = auction.address.toLowerCase();
    const cacheKey = getUserStatusCacheKey(addressKey, userKey);
    const cached = userAuctionStatusCache.get(cacheKey);

    if (cached && now - cached.updatedAt < USER_STATUS_TTL_MS) {
      statuses.set(addressKey, cached.value);
      return;
    }

    misses.push(auction);
  });

  if (!misses.length) return statuses;

  if (userAuctionStatusInFlight) {
    await userAuctionStatusInFlight.catch(() => {});
    return readUserStatusesForAuctions(auctions, userAddress);
  }

  userAuctionStatusInFlight = readOnlyBatchCall(({ campaign }) =>
    misses.map((auction) =>
      campaign(auction.address).methods.getUserAuctionStatus(userAddress)
    )
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

    userAuctionStatusCache.set(getUserStatusCacheKey(addressKey, userKey), {
      value,
      updatedAt: Date.now(),
    });
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
    auctionListCache.updatedAt || null
  );
  const [connectedAccount, setConnectedAccount] = useState(
    window.ethereum?.selectedAddress?.toLowerCase() || ""
  );
  const [visibleAuctionCount, setVisibleAuctionCount] =
    useState(AUCTIONS_PAGE_SIZE);
  const [totalAuctionCount, setTotalAuctionCount] = useState(0);
  const fetchAuctionsListRef = useRef(null);
  const isFetchingRef = useRef(false);
  const pendingFetchRef = useRef(false);
  const requestIdRef = useRef(0);
  const visibleAuctionCountRef = useRef(AUCTIONS_PAGE_SIZE);
  const normalAuctionOrderRef = useRef([]);
  const didMountVisibleCountRef = useRef(false);
  const eventRefreshTimerRef = useRef(null);
  const lastEventRefreshRef = useRef(0);

  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || Infinity
  );
  const currentUserAddress = connectedAccount;
  const searchIsActive = Boolean(searchQuery.trim());

  const loadRemainingBudget = useCallback(async (account) => {
    try {
      const budget = await getRemainingBudget(account);
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
    const incomingAuctions = sortNewestFirst(nextAuctions || []);
    const incomingByAddress = new Map(
      incomingAuctions.map((auction) => [auction.address.toLowerCase(), auction])
    );
    const incomingAddresses = incomingAuctions.map((auction) =>
      auction.address.toLowerCase()
    );

    if (!normalAuctionOrderRef.current.length) {
      normalAuctionOrderRef.current = incomingAddresses.slice(0, limit);
      return normalAuctionOrderRef.current
        .map((address) => incomingByAddress.get(address))
        .filter(Boolean);
    }

    const existingOrder = normalAuctionOrderRef.current.filter((address) =>
      incomingByAddress.has(address)
    );
    const existingSet = new Set(existingOrder);
    const highestKnownListOrder = existingOrder.reduce((highest, address) => {
      const auction = incomingByAddress.get(address);
      return Math.max(highest, Number(auction?.listOrder ?? -1));
    }, -1);

    const newAddresses = incomingAddresses.filter(
      (address) => !existingSet.has(address)
    );
    const newerAddresses = newAddresses.filter((address) => {
      const auction = incomingByAddress.get(address);
      return Number(auction?.listOrder ?? -1) > highestKnownListOrder;
    });
    const olderAddresses = newAddresses.filter(
      (address) => !newerAddresses.includes(address)
    );

    normalAuctionOrderRef.current = [
      ...newerAddresses,
      ...existingOrder,
      ...olderAddresses,
    ].slice(0, limit);

    return normalAuctionOrderRef.current
      .map((address) => incomingByAddress.get(address))
      .filter(Boolean);
  }, []);

  const fetchAuctionsList = useCallback(async () => {
    const visibleCountForRequest = visibleAuctionCount;
    const cached = getCachedAuctions(visibleAuctionCount);
    const shouldShowBackgroundRefresh =
      !loading && !loadingMore && !document.hidden;

    if (cached) {
      setAuctionsList(
        keepNormalAuctionOrder(cached.data, visibleCountForRequest)
      );
      setTotalAuctionCount(cached.total);
      setLastUpdated(auctionListCache.updatedAt);
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

    if (isFetchingRef.current) {
      pendingFetchRef.current = true;
      return;
    }

    isFetchingRef.current = true;
    if (shouldShowBackgroundRefresh) {
      setRefreshing(true);
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
      const requestKey = [
        AUCTIONS_API_URL || "chain",
        visibleCountForRequest,
        AUCTIONS_API_URL ? currentUserAddress || "" : "market",
      ].join(":");

      if (!auctionListInFlight || auctionListInFlight.key !== requestKey) {
        const promise = (async () => {
          if (AUCTIONS_API_URL) {
            try {
              return await readAuctionsFromApi(
                visibleCountForRequest,
                currentUserAddress
              );
            } catch (apiError) {
              console.warn("Auction API unavailable, falling back to chain:", apiError);
            }
          }

          return readAuctionsFromChain(visibleCountForRequest);
        })().finally(() => {
          if (auctionListInFlight?.key === requestKey) {
            auctionListInFlight = null;
          }
        });

        auctionListInFlight = { key: requestKey, promise };
      }

      const { data, total } = await auctionListInFlight.promise;

      if (
        requestId === requestIdRef.current &&
        visibleCountForRequest === visibleAuctionCountRef.current
      ) {
        setAuctionsList(keepNormalAuctionOrder(data, visibleCountForRequest));
        setTotalAuctionCount(total);
        setLastUpdated(Date.now());
        setNetworkSlow(false);
      }
    } catch (error) {
      const stale = getCachedAuctions(visibleAuctionCount);
      if (stale) {
        setAuctionsList(
          keepNormalAuctionOrder(stale.data, visibleCountForRequest)
        );
        setTotalAuctionCount(stale.total);
        setLastUpdated(auctionListCache.updatedAt);
      }
      setNetworkSlow(true);
      console.error("Error fetching auctions:", error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      isFetchingRef.current = false;
      if (pendingFetchRef.current) {
        pendingFetchRef.current = false;
        window.setTimeout(() => fetchAuctionsListRef.current?.(), 0);
      }
    }
  }, [keepNormalAuctionOrder, loading, loadingMore, visibleAuctionCount]);

  useEffect(() => {
    fetchAuctionsListRef.current = fetchAuctionsList;
  }, [fetchAuctionsList]);

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
      invalidateAuctionCaches();
      fetchAuctionsListRef.current?.();
    }, delay);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, COUNTDOWN_TICK_MS);

    return () => window.clearInterval(interval);
  }, []);

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

    window.ethereum.on?.("accountsChanged", setAccount);

    return () => {
      clearInterval(interval);
      window.ethereum.removeListener?.("accountsChanged", setAccount);
    };
  }, [navigate, loadRemainingBudget]);

  useEffect(() => {
    if (!currentUserAddress || !auctionsList.length) return undefined;

    let cancelled = false;
    const visibleAuctions = auctionsList.slice(0, visibleAuctionCount);

    readUserStatusesForAuctions(visibleAuctions, currentUserAddress)
      .then((statuses) => {
        if (cancelled || !statuses.size) return;

        setAuctionsList((currentAuctions) => {
          const result = applyUserStatusesToAuctions(
            currentAuctions,
            statuses,
            currentUserAddress
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
        console.warn("AuctionCreated subscription failed:", error)
      );
    } catch (error) {
      console.warn("Factory event subscriptions are unavailable:", error);
    }

    return () => {
      window.clearTimeout(eventRefreshTimerRef.current);
      createdEvent?.unsubscribe?.();
    };
  }, [scheduleEventRefresh]);

  const handleManualRefresh = useCallback(() => {
    invalidateAuctionCaches();
    setNetworkSlow(false);
    setRefreshing(true);
    fetchAuctionsListRef.current?.();
  }, []);

  const bidSubscriptionKey = useMemo(
    () =>
      auctionsList
        .slice(0, AUCTIONS_PAGE_SIZE)
        .filter((auction) => Number(auction.endTime) > now)
        .map((auction) => auction.address)
        .join("|"),
    [auctionsList, now]
  );

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
          console.warn("Bid subscription failed:", address, error)
        );
        bidEvents.push(bidEvent);
      });
    } catch (error) {
      console.warn("Visible auction event subscriptions are unavailable:", error);
    }

    return () => {
      bidEvents.forEach((event) => event.unsubscribe?.());
    };
  }, [bidSubscriptionKey, scheduleEventRefresh]);

  const getTimeLeft = (endTime) => {
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
    const date = new Date(Number(endTime));

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getAuctionTime = (endTime) => {
    const date = new Date(Number(endTime));

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getLastUpdatedText = () => {
    if (!lastUpdated) return "Waiting for first sync";

    const secondsAgo = Math.max(
      0,
      Math.floor((Date.now() - Number(lastUpdated)) / 1000)
    );

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
      (address) => address.toLowerCase() === currentUserAddress
    );
  };

  const isUserManager = (auction, currentUserAddress) => {
    return currentUserAddress === auction.manager.toLowerCase();
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
        const allowed = new Set(tokenCandidates[0].map((row) => row.auction.address));
        tokenCandidates.slice(1).forEach((rows) => {
          const rowAddresses = new Set(rows.map((row) => row.auction.address));
          Array.from(allowed).forEach((address) => {
            if (!rowAddresses.has(address)) allowed.delete(address);
          });
        });
        candidateRows = orderedRows.filter((row) =>
          allowed.has(row.auction.address)
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

  const sortedAuctions = useMemo(() => {
    if (sortMode === "normal") return searchedAuctions;

    const sorted = [...searchedAuctions];

    sorted.sort((a, b) => {
      if (sortMode === "ending") {
        const aOpen = Number(a.endTime) > now;
        const bOpen = Number(b.endTime) > now;
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
  }, [searchedAuctions, sortMode, now]);

  const viewIsFiltered = Boolean(deferredSearchQuery.trim());
  const loadedAuctionCount = auctionsList.length;
  const visibleResultCount = sortedAuctions.length;

  const displayedAuctions = useMemo(
    () => {
      return searchIsActive
        ? sortedAuctions
        : sortedAuctions.slice(0, visibleAuctionCount);
    },
    [sortedAuctions, searchIsActive, visibleAuctionCount]
  );

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
              <div
                style={{
                  display: "flex",
                  flexDirection: "row",
                  gap: "100px",
                  justifyContent: "center",
                  alignItems: "center",
                  width: "1100px",
                }}
              >
                <img src={picSrc} height="320" width="360" alt="metamask" />
                <div>
                  <p className={styles.introductionTitle}>
                    Welcome to the Blockchain Data Market Platform
                  </p>
                  <p style={{ fontSize: "larger" }}>
                    Scroll down to see all the open and closed auctions.
                    <br />
                    Do you want to put your data for auction?
                  </p>
                  <Button
                    variant="contained"
                    style={{
                      backgroundColor: "rgb(16, 48, 144)",
                      color: "white",
                      borderRadius: "20px",
                      padding: "10px 20px",
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
            <CircularProgress size={50} />
            <p>Loading auctions...</p>
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
                  const userWon = hasUserWonAuction(auction, currentUserAddress);
                  const userParticipated = isUserInAuction(
                    auction,
                    currentUserAddress
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
                        auction.isRefunded
                      )}
                    >
                      <TableCell
                        sx={getFontStyles(auction, currentUserAddress)}
                        align="center"
                      >
                        {auction.dataDescription}
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
                        {auction.highestBid}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentUserAddress)}
                      >
                        {auction.approversCount}
                      </TableCell>
                      <TableCell
                        sx={getFontStyles(auction, currentUserAddress)}
                        align="center"
                      >
                        {getRefundStatus(
                          auction,
                          userParticipated,
                          userWon,
                          auctionOpen
                        )}
                      </TableCell>
                      <TableCell align="center">
                        <Button
                          variant="contained"
                          style={{
                            backgroundColor: userWon
                              ? "#2e7d32"
                              : auction.isRefunded
                                ? "#FFD700"
                                : "#9090D0",
                            color: "white",
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "1rem",
                }}
              >
                <Button
                  variant="contained"
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
