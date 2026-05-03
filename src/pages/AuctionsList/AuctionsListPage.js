import React, { useState, useEffect, useCallback, useRef } from "react";
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
} from "@mui/material";
import { useNavigate, useLocation } from "react-router-dom";
import Countdown from "react-countdown";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import Layout from "../../components/Layout";
import styles from "./auctions.module.scss";
import picSrc from "./Illustration_Start.png";

const AUCTIONS_PAGE_SIZE = 20;
const FETCH_CONCURRENCY = 2;
const POLL_INTERVAL_MS = 30000;
const CACHE_TTL_MS = 10000;

let auctionListCache = {
  data: [],
  total: 0,
  visibleCount: 0,
  updatedAt: 0,
};
let auctionListInFlight = null;
const budgetCache = new Map();
const budgetInFlight = new Map();

export const userAddress = window.ethereum?.selectedAddress?.toLowerCase();

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
  if (
    auctionListCache.data.length &&
    auctionListCache.visibleCount >= visibleAuctionCount
  ) {
    return {
      data: auctionListCache.data.slice(-visibleAuctionCount),
      total: auctionListCache.total,
      fresh: Date.now() - auctionListCache.updatedAt < CACHE_TTL_MS,
    };
  }

  return null;
};

const readAuctionsFromChain = async (visibleAuctionCount, currentUserAddress) => {
  const auctions = await readOnlyCall(({ factory }) =>
    factory.methods.getDeployedCampaigns()
  );
  const visibleAuctions = auctions.slice(-visibleAuctionCount);

  const auctionData = await mapWithConcurrency(
    visibleAuctions,
    FETCH_CONCURRENCY,
    async (address) => {
      try {
        const details = await readOnlyCall(({ campaign }) =>
          campaign(address).methods.getSummary()
        );
        const addresses = details[8];
        const auctionEnded = Number(details[9]) * 1000 < Date.now();
        const closed = auctionEnded
          ? await readOnlyCall(({ campaign }) =>
              campaign(address).methods.getStatus()
            )
          : false;

        let isRefunded = false;
        const isHighestBidder =
          currentUserAddress &&
          details[7].toLowerCase() === currentUserAddress;
        const isManager =
          currentUserAddress &&
          details[3].toLowerCase() === currentUserAddress;
        const userInAuction =
          currentUserAddress &&
          addresses.some(
            (address) => address.toLowerCase() === currentUserAddress
          );

        if (userInAuction && auctionEnded && !isHighestBidder && !isManager) {
          const balance = await readOnlyCall(({ campaign }) =>
            campaign(address).methods.getBid(currentUserAddress)
          );
          isRefunded = Number(balance) === 0;
        }

        return {
          address,
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
        };
      } catch (error) {
        console.warn("Skipping auction after RPC read failed:", address, error);
        return null;
      }
    }
  );

  const data = auctionData.filter(Boolean);

  auctionListCache = {
    data,
    total: auctions.length,
    visibleCount: visibleAuctionCount,
    updatedAt: Date.now(),
  };

  return auctionListCache;
};

function AuctionsListPage() {
  const navigate = useNavigate();
  const { state: navState } = useLocation();
  const [auctionsList, setAuctionsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [visibleAuctionCount, setVisibleAuctionCount] =
    useState(AUCTIONS_PAGE_SIZE);
  const [totalAuctionCount, setTotalAuctionCount] = useState(0);
  const fetchAuctionsListRef = useRef(null);
  const isFetchingRef = useRef(false);
  const requestIdRef = useRef(0);
  const didMountVisibleCountRef = useRef(false);

  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || Infinity
  );

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

  const fetchAuctionsList = useCallback(async () => {
    const cached = getCachedAuctions(visibleAuctionCount);

    if (cached?.fresh) {
      setAuctionsList(cached.data);
      setTotalAuctionCount(cached.total);
      setLoading(false);
      return;
    }

    if (isFetchingRef.current) return;

    isFetchingRef.current = true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
      auctionListInFlight =
        auctionListInFlight ||
        readAuctionsFromChain(visibleAuctionCount, currentUserAddress).finally(
          () => {
            auctionListInFlight = null;
          }
        );
      const { data, total } = await auctionListInFlight;

      if (requestId === requestIdRef.current) {
        setAuctionsList(data.slice(-visibleAuctionCount));
        setTotalAuctionCount(total);
      }
    } catch (error) {
      const stale = getCachedAuctions(visibleAuctionCount);
      if (stale) {
        setAuctionsList(stale.data);
        setTotalAuctionCount(stale.total);
      }
      console.error("Error fetching auctions:", error);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [visibleAuctionCount]);

  useEffect(() => {
    fetchAuctionsListRef.current = fetchAuctionsList;
  }, [fetchAuctionsList]);

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
      if (nextAccount) {
        loadRemainingBudget(nextAccount);
      }
      fetchAuctionsListRef.current?.();
    };

    window.ethereum
      .request({ method: "eth_accounts" })
      .then(setAccount)
      .catch((error) => console.error("Error reading accounts:", error));

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

  const getTimeLeft = (endTime) => {
    return Number(endTime) < Date.now() ? (
      <div>Closed</div>
    ) : (
      <Countdown date={endTime} />
    );
  };

  const isAuctionOpen = (endTime) => {
    return Number(endTime) > Date.now();
  };

  const isHighestBidder = (auction, currentUserAddress) => {
    return auction.highestBidder?.toLowerCase() === currentUserAddress;
  };

  const hasUserWonAuction = (auction) => {
    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
    const auctionEnded = Number(auction.endTime) < Date.now();
    const userIsHighestBidder = isHighestBidder(auction, currentUserAddress);
    return auctionEnded && userIsHighestBidder;
  };

  const isUserInAuction = (auction) => {
    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
    return !!auction?.addresses?.some(
      (address) => address.toLowerCase() === currentUserAddress
    );
  };

  const isUserManager = (auction) => {
    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
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
        : isUserInAuction(auction) &&
            isAuctionOpen(auction.endTime) &&
            !isUserManager(auction)
          ? "#da0c0cff"
          : isOpen
            ? "#D07030D0"
            : "#0D0D4E",
  });

  const getRefundStatus = (auction, userParticipated, userWon, auctionOpen) => {
    const isManager = isUserManager(auction);

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
            style={{
              padding: "5px 20px",
              borderRadius: "20px",
              width: "100%",
            }}
          >
            <Table aria-label="auctions table">
              <TableHead>
                <TableRow>
                  {[
                    "Description",
                    "Auction Status",
                    "Highest Bid",
                    "Number Of Bidders",
                    "Payment Status",
                    "",
                  ].map((title, idx) => (
                    <TableCell
                      key={idx}
                      align={idx > 0 ? "center" : "left"}
                      style={{ color: "#0d0d4eff", fontWeight: "bold" }}
                    >
                      {title}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {auctionsList.slice().reverse().map((auction, index) => {
                  const userWon = hasUserWonAuction(auction);
                  const userParticipated = isUserInAuction(auction);
                  const auctionOpen = isAuctionOpen(auction.endTime);
                  const currentAddress =
                    window.ethereum?.selectedAddress?.toLowerCase();

                  return (
                    <TableRow
                      key={`${auction.address}-${index}`}
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
                        sx={getFontStyles(auction, currentAddress)}
                        align="center"
                      >
                        {auction.dataDescription}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentAddress, true)}
                        style={{ fontWeight: "bold" }}
                      >
                        {getTimeLeft(auction.endTime)}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentAddress)}
                      >
                        {auction.highestBid}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={getFontStyles(auction, currentAddress)}
                      >
                        {auction.approversCount}
                      </TableCell>
                      <TableCell
                        sx={getFontStyles(auction, currentAddress)}
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
                  }}
                  onClick={() =>
                    setVisibleAuctionCount(
                      (count) => count + AUCTIONS_PAGE_SIZE
                    )
                  }
                >
                  Load More Auctions
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
