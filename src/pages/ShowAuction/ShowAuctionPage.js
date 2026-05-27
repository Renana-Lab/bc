/* eslint-env es2020 */
import {
  useReducer,
  useEffect,
  useMemo,
  useCallback,
  useState,
  useRef,
} from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import moment from "moment";
import Layout from "../../components/Layout";
import Campaign from "../../real_ethereum/campaign";
import ContributeForm from "../../components/ContributeForm";
import Countdown from "react-countdown";
import toast from "react-hot-toast";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { campaignSocket } from "../../real_ethereum/socketFactory";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  CircularProgress,
} from "@mui/material";
import {
  Gavel as GavelIcon,
  ListOutlined as ListIcon,
  KeyboardReturnOutlined as ReturnIcon,
  Close as CloseIcon,
} from "@mui/icons-material";
import showPageStyles from "./show.module.scss";
import picSrc from "./medal.png";
import {
  getRemainingBudget,
  invalidateRemainingBudgetCache,
  setRemainingBudgetCache,
} from "../AuctionsList/AuctionsListPage";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { notifyBudgetChanged } from "../../real_ethereum/budget";

const buttonStyle = {
  height: "2.5rem",
  borderRadius: "1rem",
  backgroundColor: "#103090",
  color: "#D8DCF0",
  fontWeight: "600",
  // border: "1px solid #002884",
};

const ACTIVE_AUCTION_POLL_INTERVAL_MS = 5000;
const ENDED_AUCTION_POLL_INTERVAL_MS = 45000;

const initialState = {
  dialogOpen: false,
  displayBiddingDialog: false,
  auction: null,
  connectedAccount: "",
  minimumContribution: 0,
  approversCount: 0,
  manager: "",
  highestBid: 0,
  dataForSell: "",
  dataDescription: "",
  endTime: 0,
  highestBidder: "",
  transactions: [],
  contributors: [],
  refundsProcessed: false,
  closed: false,
  userBid: 0,
  loading: true,
  error: null,
};

function transactionsToCSV(transactions) {
  const CSV_COLUMNS = [
    { key: "bidder", label: "Bidder Address" },
    { key: "transactionAmount", label: "Transaction Amount (wei)" },
    { key: "bid", label: "Cumulative Bid (wei)" },
    { key: "time", label: "Bid Time" },
  ];
  const requiredKeys = CSV_COLUMNS.map(({ key }) => key);

  // Validation
  const isValid = transactions.every(
    (tx) => typeof tx === "object" && requiredKeys.every((key) => key in tx),
  );

  if (!isValid) {
    throw new Error("Invalid transaction structure");
  }

  // Header
  const header = CSV_COLUMNS.map(({ label }) => label).join(",");

  // Rows
  const rows = transactions.map((tx) =>
    CSV_COLUMNS.map(
      ({ key }) => `"${String(tx[key]).replace(/"/g, '""')}"`,
    ).join(","),
  );

  return [header, ...rows].join("\n");
}

function downloadCSV(transactions, filename = "transactions.csv") {
  const csv = transactionsToCSV(transactions);

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();

  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const reducer = (state, action) => {
  switch (action.type) {
    case "SET_AUCTION_DATA":
      return { ...state, ...action.payload, loading: false };
    case "SET_LOADING":
      return { ...state, loading: true };
    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };
    case "TOGGLE_DIALOG":
      return { ...state, dialogOpen: !state.dialogOpen };
    case "TOGGLE_BIDDING_DIALOG":
      return { ...state, displayBiddingDialog: !state.displayBiddingDialog };
    default:
      return state;
  }
};

function ShowAuctionPage() {
  const [finalizingPayment, setFinalizingPayment] = useState(false);
  const [state, dispatch] = useReducer(reducer, initialState);
  const fetchInFlightRef = useRef(false);
  const eventRefreshTimerRef = useRef(null);
  const { address } = useParams();
  const navigate = useNavigate();
  const { state: navState } = useLocation();
  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || 0,
  );

  useEffect(() => {
    // console.log("🔁 Updated budget:", remainingBudget);
  }, [remainingBudget]);

  const handleExport = () => {
    try {
      downloadCSV(state.transactions);
    } catch (err) {
      toast.error(
        "CSV download not available: invalid transaction format found",
      );
    }
  };

  const isAuctionActive = useMemo(
    () => Number(state.endTime + "000") > Date.now(),
    [state.endTime],
  );
  const isManager = useMemo(
    () =>
      state.manager?.toLowerCase() === state.connectedAccount?.toLowerCase(),
    [state.manager, state.connectedAccount],
  );
  const isHighestBidder = useMemo(
    () =>
      state.highestBidder?.toLowerCase() ===
      state.connectedAccount?.toLowerCase(),
    [state.highestBidder, state.connectedAccount],
  );
  const hasUserBid = useMemo(
    () =>
      state.contributors.some(
        (addr) => addr.toLowerCase() === state.connectedAccount?.toLowerCase(),
      ),
    [state.contributors, state.connectedAccount],
  );

  const fetchAuctionData = useCallback(async () => {
    if (!window.ethereum) return navigate("/");
    if (fetchInFlightRef.current) return;

    fetchInFlightRef.current = true;

    try {
      const accounts = await window.ethereum.request({
        method: "eth_accounts",
      });
      const auctionInstance = Campaign(address); // אם סינכרוני

      const account = accounts[0] || "";

      let summary;
      let summaryIsLight = true;

      const compatibilityReadOptions = {
        preferInjected: false,
        allowInjectedFallback: false,
      };

      try {
        summary = await readOnlyCall(
          ({ campaign }) => campaign(address).methods.getListSummary(),
          undefined,
          compatibilityReadOptions,
        );
      } catch (error) {
        summaryIsLight = false;
        summary = await readOnlyCall(
          ({ campaign }) => campaign(address).methods.getSummary(),
          undefined,
          compatibilityReadOptions,
        );
      }

      const minimumContribution = summary[0];
      const approversCount = summary[2];
      const manager = summary[3];
      const highestBid = summary[4];
      let dataForSell = summaryIsLight ? "" : summary[5];
      const dataDescription = summaryIsLight ? summary[5] : summary[6];
      const highestBidder = summaryIsLight ? summary[6] : summary[7];
      const addresses = summaryIsLight ? [] : summary[8];
      const endTime = summaryIsLight ? summary[7] : summary[9];
      const closedFromSummary = summaryIsLight ? Boolean(summary[8]) : null;
      const auctionEnded = Number(endTime) * 1000 < Date.now();
      const accountKey = account.toLowerCase();
      const highestBidderKey = (highestBidder || "").toLowerCase();
      const userIsHighestBidder =
        Boolean(accountKey) && accountKey === highestBidderKey;

      const [rawTransactions, userStatus, fallbackUserBid, closed] =
        await Promise.all([
          auctionEnded
            ? readOnlyCall(
                ({ campaign }) => campaign(address).methods.getTransactions(),
                undefined,
                compatibilityReadOptions,
              )
            : Promise.resolve([]),
          summaryIsLight && account
            ? readOnlyCall(
                ({ campaign }) =>
                  campaign(address).methods.getUserAuctionStatus(account),
                undefined,
                compatibilityReadOptions,
              ).catch(() => null)
            : Promise.resolve(null),
          account
            ? summaryIsLight
              ? Promise.resolve(0)
              : readOnlyCall(
                  ({ campaign }) => campaign(address).methods.getBid(account),
                  undefined,
                  compatibilityReadOptions,
                )
            : Promise.resolve(0),
          summaryIsLight
            ? Promise.resolve(closedFromSummary)
            : auctionEnded
              ? readOnlyCall(
                  ({ campaign }) => campaign(address).methods.getStatus(),
                  undefined,
                  compatibilityReadOptions,
                )
              : Promise.resolve(false),
        ]);
      const userBid = userStatus ? userStatus[1] : fallbackUserBid;
      const userParticipated = userStatus
        ? Boolean(userStatus[0])
        : addresses.some((addr) => addr.toLowerCase() === accountKey);
      const contributors =
        summaryIsLight && userParticipated ? [account] : addresses;

      if (auctionEnded && closed && userIsHighestBidder && !dataForSell) {
        dataForSell = await auctionInstance.methods
          .getData()
          .call({ from: account })
          .catch(() => "");
      }

      // rawTransactions: [{ bidderAddress, value, time }, ...]   // time in SECONDS (string/number)
      const norm = rawTransactions.map((tx, idx) => ({
        // 1) normalize each tx and remember its original index
        idx, //    keep original position to restore order later
        bidder: tx.bidderAddress, //    human-facing bidder address (as given)
        key: tx.bidderAddress.toLowerCase(), //    normalized key (lowercase) to avoid 0xAbc vs 0xabc duplicates
        value: BigInt(tx.value), //    convert bid value (wei) to BigInt for safe math
        time: BigInt(tx.time), //    convert timestamp (seconds) to BigInt for comparisons
      }));

      // Sort by time asc; if times are equal, keep original order (by idx) for stability
      const byTime = [...norm].sort(
        (
          a,
          b, // 2) make a copy and sort it (don’t mutate norm)
        ) =>
          a.time === b.time //    if same timestamp…
            ? a.idx - b.idx //    …fallback to original order (stable tie-breaker)
            : a.time < b.time
              ? -1
              : 1, //    otherwise earlier time first
      );

      const sumByBidder = new Map(); // 3) running totals per bidderKey (key → BigInt total)
      const cumIncl = Array(norm.length).fill(0n); // 4) array to hold cumulative totals INCLUDING current bid,
      //    aligned to original indices

      for (const tx of byTime) {
        // 5) walk bids in chronological order
        const prev = sumByBidder.get(tx.key) ?? 0n; //    previous total for this bidder (0n if none) — `??` handles undefined
        const next = prev + tx.value; //    add current bid → cumulative total up to and INCLUDING this bid
        sumByBidder.set(tx.key, next); //    store updated total for this bidder
        cumIncl[tx.idx] = next; //    write the result at the ORIGINAL index position
      }

      const highestBidValue = BigInt(highestBid || 0);
      const transactions = norm.map((tx, i) => ({
        // 6) build your display-friendly array in original order
        bidder: tx.bidder, //    original-cased address for display
        transactionAmount: tx.value.toString(), //    raw amount sent in this transaction, as Etherscan displays it
        bid: cumIncl[i].toString(), //    cumulative (≤ current time), BigInt → string for UI
        time: moment.unix(Number(tx.time)).format(
          //    format seconds timestamp to "DD-MM-YYYY HH:mm:ss"
          "DD-MM-YYYY HH:mm:ss",
        ),
        isHighestBid:
          Boolean(highestBidderKey) &&
          tx.key === highestBidderKey &&
          cumIncl[i] === highestBidValue,
      }));
      transactions.reverse();

      const refundsProcessed = userStatus
        ? Boolean(userStatus[2])
        : closed &&
          Boolean(accountKey) &&
          accountKey !== highestBidderKey &&
          userParticipated &&
          Number(userBid) === 0;

      dispatch({
        type: "SET_AUCTION_DATA",
        payload: {
          connectedAccount: account,
          auction: auctionInstance,
          minimumContribution,
          approversCount,
          manager,
          highestBid,
          dataForSell,
          dataDescription,
          endTime,
          highestBidder,
          transactions,
          contributors,
          refundsProcessed,
          userBid: Number(userBid),
          closed,
        },
      });

      if (account && !auctionEnded) {
        const loadBudget = async () => {
          const budget = await getRemainingBudget(account.toLowerCase());
          setRemainingBudget(budget);
        };
        loadBudget(); // הפעלה בפועל
      }
    } catch (err) {
      console.error(err);
      dispatch({ type: "SET_ERROR", payload: "Error fetching auction data" });
      toast.error("Error fetching auction data");
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [address, navigate]);

  const finalizeAuction = useCallback(async () => {
    if (!state.auction || !state.connectedAccount) return;

    try {
      setFinalizingPayment(true);
      await state.auction.methods.finalizeAuctionIfNeeded().send({
        from: state.connectedAccount,
      });
      toast.success("Auction finalized, seller payment sent.");
      dispatch({ type: "SET_AUCTION_DATA", payload: { closed: true } });
      await fetchAuctionData();
    } catch (err) {
      console.error("Error during finalization:", err);
      toast.error("Could not finalize payment yet.");
    } finally {
      setFinalizingPayment(false);
    }
  }, [state.auction, state.connectedAccount, fetchAuctionData]);

  const claimRefund = useCallback(async () => {
    if (!state.auction || !state.connectedAccount) return;

    try {
      await state.auction.methods.withdrawRefund().send({
        from: state.connectedAccount,
      });
      toast.success("Refund claimed.");
      await fetchAuctionData();
    } catch (err) {
      console.error("Error claiming refund:", err);
      toast.error("Refund is not available yet.");
    }
  }, [state.auction, state.connectedAccount, fetchAuctionData]);

  const scheduleEventRefresh = useCallback(() => {
    if (document.hidden) return;

    window.clearTimeout(eventRefreshTimerRef.current);
    eventRefreshTimerRef.current = window.setTimeout(() => {
      fetchAuctionData();
    }, 800);
  }, [fetchAuctionData]);

  const handleSuccessfulBid = useCallback(
    async (bidResult = {}) => {
      const account = state.connectedAccount?.toLowerCase();
      const factoryAddress = getActiveFactoryAddress();
      if (!account || !address) {
        toast.error("Missing account or campaign address");
        return;
      }

      const applyBudget = (budget) => {
        if (budget === undefined || budget === null) return;

        const nextBudget = String(budget);
        setRemainingBudget(nextBudget);
        setRemainingBudgetCache(account, nextBudget, factoryAddress);
        notifyBudgetChanged({
          userAddress: account,
          factoryAddress,
          budget: nextBudget,
        });
      };

      try {
        const hasReceiptBudget =
          bidResult.budgetAfter !== undefined && bidResult.budgetAfter !== null;

        if (hasReceiptBudget) {
          applyBudget(bidResult.budgetAfter);
        } else {
          invalidateRemainingBudgetCache(account, factoryAddress);
          notifyBudgetChanged({ userAddress: account, factoryAddress });

          const afterBudget = await getRemainingBudget(
            account,
            factoryAddress,
            {
              force: true,
            },
          );
          applyBudget(afterBudget);
        }

        await fetchAuctionData();

        if (hasReceiptBudget) {
          window.setTimeout(async () => {
            try {
              const verifiedBudget = await getRemainingBudget(
                account,
                factoryAddress,
                {
                  force: true,
                },
              );
              applyBudget(verifiedBudget);
            } catch (error) {
              console.warn("Budget verification after bid failed:", error);
            }
          }, 1200);
        }
      } catch (error) {
        toast.error("Error updating bid info: " + error.message);
      }
    },
    [address, state.connectedAccount, fetchAuctionData],
  );

  const InfoItem = ({ label, value }) => (
    <p className={showPageStyles.introductionDetail}>
      <span className={showPageStyles.introductionLabel}>{label}: </span>
      <span className={showPageStyles.introductionText}>{value}</span>
    </p>
  );

  useEffect(() => {
    fetchAuctionData();
    let interval;
    if (isAuctionActive) {
      interval = setInterval(() => {
        if (!document.hidden) fetchAuctionData();
      }, ACTIVE_AUCTION_POLL_INTERVAL_MS);
    } else if (!state.closed) {
      interval = setInterval(() => {
        if (!document.hidden) fetchAuctionData();
      }, ENDED_AUCTION_POLL_INTERVAL_MS);
    }
    return () => interval && clearInterval(interval);
  }, [fetchAuctionData, isAuctionActive, state.closed]);

  useEffect(() => {
    let bidEvent;
    let refundEvent;
    let sellerPaidEvent;

    try {
      const auctionEvents = campaignSocket(address);
      bidEvent = auctionEvents.events.BidAdded();
      refundEvent = auctionEvents.events.RefundProcessed();
      sellerPaidEvent = auctionEvents.events.SellerPaid();

      bidEvent.on("data", scheduleEventRefresh);
      refundEvent.on("data", scheduleEventRefresh);
      sellerPaidEvent.on("data", scheduleEventRefresh);

      bidEvent.on("error", (error) =>
        console.warn("Bid event subscription failed:", error),
      );
      refundEvent.on("error", (error) =>
        console.warn("Refund event subscription failed:", error),
      );
      sellerPaidEvent.on("error", (error) =>
        console.warn("Seller payment event subscription failed:", error),
      );
    } catch (error) {
      console.warn("Auction event subscriptions are unavailable:", error);
    }

    return () => {
      window.clearTimeout(eventRefreshTimerRef.current);
      bidEvent?.unsubscribe?.();
      refundEvent?.unsubscribe?.();
      sellerPaidEvent?.unsubscribe?.();
    };
  }, [address, scheduleEventRefresh]);

  const renderAuctionInfo = () => (
    <DialogActions>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
        }}
      >
        <div className={showPageStyles.campaignInfo}>
          <p className={showPageStyles.introductionTitle}>
            Auction # {address}
          </p>
          <hr />
          <InfoItem label="Data description" value={state.dataDescription} />
          <InfoItem label="Seller address" value={state.manager} />
          {isAuctionActive && (
            <InfoItem
              label="Time left"
              value={<Countdown date={Number(state.endTime + "000")} />}
            />
          )}
          <InfoItem
            label="Minimum bid (wei) required"
            value={state.minimumContribution}
          />
          <InfoItem
            label="Highest bid (wei) recorded"
            value={state.highestBid}
          />
          <InfoItem label="Number of bidders" value={state.approversCount} />
        </div>

        {!state.closed &&
          !isAuctionActive &&
          isManager &&
          state.transactions.length !== 0 && (
            <Button
              id="finalize-auction-button"
              variant="contained"
              disabled={finalizingPayment}
              style={{ ...buttonStyle, marginTop: "2rem", width: "24rem" }}
              onClick={finalizeAuction}
            >
              {finalizingPayment ? "Finalizing payment..." : "Get your money"}
            </Button>
          )}

        {state.closed &&
          !isAuctionActive &&
          isManager &&
          state.transactions.length !== 0 && (
            <Button
              variant="contained"
              disabled
              style={{ ...buttonStyle, marginTop: "2rem", width: "24rem" }}
            >
              Seller payment finalized
            </Button>
          )}

        {!isAuctionActive && isManager && (
          <Button
            startIcon={<ListIcon />}
            variant="contained"
            style={{ ...buttonStyle, marginTop: "2rem", width: "24rem" }}
            onClick={() => dispatch({ type: "TOGGLE_DIALOG" })}
          >
            Display Bidding History
          </Button>
        )}
        <br />
        <Button
          startIcon={isAuctionActive ? <GavelIcon /> : <ReturnIcon />}
          onClick={() =>
            navigate("/auctions-list", { state: { remainingBudget } })
          }
          style={{
            ...buttonStyle,
            marginTop: "0.7rem",
            // width: isAuctionActive ? "24rem" : "24rem",
            width: "24rem",

            marginBottom: "2rem",
          }}
          variant="contained"
        >
          {isAuctionActive
            ? "Return To Auctions"
            : "Return To Auctions Main Screen"}
        </Button>
      </Box>
    </DialogActions>
  );

  if (state.loading)
    return (
      <Layout>
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: "100vh",
          }}
        >
          <CircularProgress />
        </Box>
      </Layout>
    );
  if (state.error)
    return (
      <Layout>
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: "100vh",
          }}
        >
          <Typography color="error">{state.error}</Typography>
        </Box>
      </Layout>
    );

  return (
    <Layout>
      <div className={showPageStyles.page}>
        {renderAuctionInfo()}
        {isAuctionActive && !isManager && (
          <div className={showPageStyles.contributeForm}>
            <Typography
              variant="h6"
              textAlign="center"
              sx={{ marginBottom: "1rem" }}
            >
              Remaining Budget:{" "}
              {remainingBudget === Infinity
                ? "Unlimited"
                : `${remainingBudget} wei`}
            </Typography>
            <ContributeForm
              address={address}
              remainingBudget={remainingBudget}
              onSuccessfulBid={handleSuccessfulBid}
              userBid={state.userBid}
            />
          </div>
        )}
        {!isAuctionActive && isHighestBidder && (
          <div className={showPageStyles.contributeForm}>
            <div className={showPageStyles.centered}>
              <img alt="medal" width="80px" src={picSrc} />
              <div className={showPageStyles.winnerTitle}>Congrats!</div>
              <div className={showPageStyles.winnerLabel}>
                You won the auction and have now access to the data
              </div>
              {!state.displayBiddingDialog && (
                <Button
                  variant="contained"
                  className={showPageStyles.viewDataButton}
                  onClick={() => dispatch({ type: "TOGGLE_BIDDING_DIALOG" })}
                >
                  View Data
                </Button>
              )}
            </div>
            {state.displayBiddingDialog && (
              <div className={showPageStyles.revealedData}>
                <InfoItem
                  label="Data Description"
                  value={state.dataDescription}
                />
                <InfoItem label="Data acquired" value={state.dataForSell} />
              </div>
            )}
          </div>
        )}
        {!isAuctionActive && !isManager && hasUserBid && !isHighestBidder && (
          <div className={showPageStyles.contributeForm}>
            <Typography
              variant="h6"
              textAlign="center"
              sx={{ marginBottom: "1rem" }}
            >
              {state.refundsProcessed
                ? "You did not win the auction. Your bid has been refunded."
                : state.closed
                  ? "You did not win the auction. Your refund is queued automatically."
                  : "You did not win the auction. Awaiting auction finalization."}
            </Typography>
            {state.closed && !state.refundsProcessed && state.userBid > 0 && (
              <Button
                variant="contained"
                style={{ ...buttonStyle, marginTop: "1rem", width: "18rem" }}
                onClick={claimRefund}
              >
                Claim refund now
              </Button>
            )}
          </div>
        )}
      </div>
      {!isAuctionActive && isManager && (
        <Dialog
          fullWidth
          open={state.dialogOpen}
          onClose={() => dispatch({ type: "TOGGLE_DIALOG" })}
        >
          <DialogTitle>
            <Box
              display="flex"
              justifyContent="flex-start"
              flexDirection="row-reverse"
              alignItems="center"
              gap="140px"
            >
              <Button onClick={() => dispatch({ type: "TOGGLE_DIALOG" })}>
                <CloseIcon
                  sx={{
                    color: "black",
                    background: "#9090D0",
                    borderRadius: "20px",
                    padding: "4px",
                  }}
                />
              </Button>
              <p className={showPageStyles.title}>Bidding History</p>
            </Box>
            <p className={showPageStyles.subTitle}>Auction # {address}</p>
            <p className={showPageStyles.subTitle}>
              Highest bid: {state.highestBid} wei
            </p>
            <p
              className={showPageStyles.subTitle}
              style={{ wordBreak: "break-all" }}
            >
              Highest bidder: {state.highestBidder || "None"}
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Button
                style={{ ...buttonStyle, width: "15rem" }}
                onClick={handleExport}
              >
                Export Transactions
              </Button>
            </div>
          </DialogTitle>
          <DialogContent>
            <DialogContentText>
              {state.transactions.length ? (
                <TableContainer component={Paper}>
                  <Table sx={{ minWidth: 650 }} aria-label="bids">
                    <TableHead>
                      <TableRow>
                        <TableCell className={showPageStyles.headerCell}>
                          Bidder Address
                        </TableCell>
                        <TableCell
                          className={showPageStyles.headerCell}
                          align="center"
                        >
                          Tx Amount
                        </TableCell>
                        <TableCell
                          className={showPageStyles.headerCell}
                          align="center"
                        >
                          Cumulative Bid
                        </TableCell>
                        <TableCell
                          className={showPageStyles.headerCell}
                          align="center"
                        >
                          Contract Status
                        </TableCell>
                        <TableCell
                          className={showPageStyles.headerCell}
                          align="center"
                        >
                          Bid Time
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {state.transactions.map((row, index) => (
                        <TableRow
                          key={index}
                          sx={
                            row.isHighestBid
                              ? { backgroundColor: "#E8F5E9" }
                              : undefined
                          }
                        >
                          <TableCell align="center">{row.bidder}</TableCell>
                          <TableCell align="center">
                            {row.transactionAmount}
                          </TableCell>
                          <TableCell align="center">{row.bid}</TableCell>
                          <TableCell align="center">
                            {row.isHighestBid ? "Highest bid" : ""}
                          </TableCell>
                          <TableCell align="center">{row.time}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              ) : (
                <span>No one contributed to this auction!</span>
              )}
            </DialogContentText>
          </DialogContent>
        </Dialog>
      )}
    </Layout>
  );
}

export default ShowAuctionPage;
