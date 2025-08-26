/* eslint-env es2020 */
import { useReducer, useEffect, useMemo, useCallback, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import moment from "moment";
import Layout from "../../components/Layout";
import Campaign from "../../real_ethereum/campaign";
import ContributeForm from "../../components/ContributeForm";
import Countdown from "react-countdown";
import toast from "react-hot-toast";
import web3 from "../../real_ethereum/web3.js";
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
} from "../AuctionsList/AuctionsListPage";


const buttonStyle = {
  height: "2.5rem",
  borderRadius: "1rem",
  backgroundColor: "#103090",
  color: "#D8DCF0",
  fontWeight: "600",
  border: "1px solid #002884",
};

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
  userBid: 0,
  loading: true,
  error: null,
};



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
  const [finalizedClicked, setFinalizedClicked] = useState(false);
  
  const [state, dispatch] = useReducer(reducer, initialState);
  const [hasHandledAuctionEnd, setHasHandledAuctionEnd] = useState(false);
  const { address } = useParams();
  const navigate = useNavigate();
  const { state: navState } = useLocation();
  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || 0
  );
  useEffect(() => {
  // console.log("🔁 Updated budget:", remainingBudget);
  }, [remainingBudget]);

  const isAuctionActive = useMemo(
    () => Number(state.endTime + "000") > Date.now(),
    [state.endTime]
  );
  const isManager = useMemo(
    () =>
      state.manager?.toLowerCase() === state.connectedAccount?.toLowerCase(),
    [state.manager, state.connectedAccount]
  );
  const isHighestBidder = useMemo(
    () =>
      state.highestBidder?.toLowerCase() ===
      state.connectedAccount?.toLowerCase(),
    [state.highestBidder, state.connectedAccount]
  );
  const hasUserBid = useMemo(
    () =>
      state.contributors.some(
        (addr) => addr.toLowerCase() === state.connectedAccount?.toLowerCase()
      ),
    [state.contributors, state.connectedAccount]
  );

  const fetchAuctionData = useCallback(async () => {
  if (!window.ethereum) return navigate("/");

  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const auctionInstance = Campaign(address); // אם סינכרוני
    console.log("Address is:", address);  // אם זה undefined — זו הבעיה.


    const account = accounts[0] || "";

    const summary = await auctionInstance.methods.getSummary().call();

    const minimumContribution = summary[0];
    const balance = summary[1];
    const approversCount = summary[2];
    const manager = summary[3];
    const highestBid = summary[4];
    const dataForSell = summary[5];
    const dataDescription = summary[6];
    const highestBidder = summary[7];
    const addresses = summary[8];
    const endTime = summary[9];

    const [rawTransactions, userBid, closed] = await Promise.all([
      auctionInstance.methods.getTransactions().call(),
      account ? auctionInstance.methods.getBid(account).call() : Promise.resolve(0),
      auctionInstance.methods.getStatus().call(),
    ]);

    // rawTransactions: [{ bidderAddress, value, time }, ...]   // time in SECONDS (string/number)
    const norm = rawTransactions.map((tx, idx) => ({         // 1) normalize each tx and remember its original index
      idx,                                                   //    keep original position to restore order later
      bidder: tx.bidderAddress,                              //    human-facing bidder address (as given)
      key: tx.bidderAddress.toLowerCase(),                   //    normalized key (lowercase) to avoid 0xAbc vs 0xabc duplicates
      value: BigInt(tx.value),                               //    convert bid value (wei) to BigInt for safe math
      time: BigInt(tx.time),                                 //    convert timestamp (seconds) to BigInt for comparisons
    }));

    // Sort by time asc; if times are equal, keep original order (by idx) for stability
    const byTime = [...norm].sort((a, b) =>                  // 2) make a copy and sort it (don’t mutate norm)
      a.time === b.time                                      //    if same timestamp…
        ? a.idx - b.idx                                      //    …fallback to original order (stable tie-breaker)
        : a.time < b.time ? -1 : 1                           //    otherwise earlier time first
    );

    const sumByBidder = new Map();                           // 3) running totals per bidderKey (key → BigInt total)
    const cumIncl = Array(norm.length).fill(0n);             // 4) array to hold cumulative totals INCLUDING current bid,
                                                            //    aligned to original indices

    for (const tx of byTime) {                               // 5) walk bids in chronological order
      const prev = sumByBidder.get(tx.key) ?? 0n;            //    previous total for this bidder (0n if none) — `??` handles undefined
      const next = prev + tx.value;                          //    add current bid → cumulative total up to and INCLUDING this bid
      sumByBidder.set(tx.key, next);                         //    store updated total for this bidder
      cumIncl[tx.idx] = next;                                //    write the result at the ORIGINAL index position
    }

    const transactions = norm.map((tx, i) => ({              // 6) build your display-friendly array in original order
      bidder: tx.bidder,                                     //    original-cased address for display
      bid: cumIncl[i].toString(),                            //    cumulative (≤ current time), BigInt → string for UI
      time: moment.unix(Number(tx.time)).format(             //    format seconds timestamp to "DD-MM-YYYY HH:mm:ss"
        "DD-MM-YYYY HH:mm:ss"
      ),
    }));
    transactions.reverse();


    let refundsProcessed = false;

    if (closed) {
      const stillOwed = await Promise.all(
        addresses
          .filter((addr) => addr.toLowerCase() !== highestBidder.toLowerCase())
          .map(async (addr) => {
            const owed = await auctionInstance.methods.getBid(addr).call();
            return Number(owed) > 0;
          })
      );
      refundsProcessed = !stillOwed.includes(true);

      if (refundsProcessed) {
        const ethBalances = await Promise.all(
          addresses.map((addr) => web3.eth.getBalance(addr))
        );
        const contractBalance = BigInt(await web3.eth.getBalance(auctionInstance.options.address));
        const managerBalance = BigInt(await web3.eth.getBalance(manager));

        if (contractBalance !== 0n) refundsProcessed = false;
        if (managerBalance < BigInt(highestBid)) refundsProcessed = false;
      }
    }

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
        contributors: addresses,
        refundsProcessed,
        userBid: Number(userBid),
        closed,
      },
    });

    if (account) {
      console.log("setRemainingBudget is eexecuted in setRemainingBudget(getRemainingBudget(account.toLowerCase()));");
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
  }
}, [address, navigate]);

const finalizeAuction = useCallback(async () => {
  if (!state.auction) return;

  try {
    setFinalizedClicked(true); // ✅ לחצו על הכפתור
    console.log("⏳ Finalizing auction from:", state.manager);
    const summaryBefore = await state.auction.methods.getSummary().call();
    const addresses = await state.auction.methods.getAddresses().call();

    const balancesBefore = await Promise.all(
      addresses.map(addr => web3.eth.getBalance(addr))
    );
    const managerBalanceBefore = await web3.eth.getBalance(state.manager);

    await state.auction.methods.finalizeAuctionIfNeeded().send({ from: state.manager });

    const managerBalanceAfter = await web3.eth.getBalance(state.manager);

    toast.success(`Auction finalized, you were paid!`);

 
    const summaryAfter = await state.auction.methods.getSummary().call();
    const closed = await state.auction.methods.getStatus().call();
    const balancesAfter = await Promise.all(
      addresses.map(addr => web3.eth.getBalance(addr))
    );

    console.log("✅ Auction closed:", closed);
    console.log("🏆 Highest bidder:", summaryAfter[7]);
    console.log("💰 Highest bid:", web3.utils.fromWei(summaryAfter[4], "ether"), "ETH");

    console.log("💸 Seller (manager) balance change:",
      web3.utils.fromWei((BigInt(managerBalanceAfter) - BigInt(managerBalanceBefore)).toString(), "ether"),
      "ETH"
    );

    addresses.forEach((addr, i) => {
      if (addr !== summaryAfter[7]) {
        const refundAmount = BigInt(balancesAfter[i]) - BigInt(balancesBefore[i]);
        console.log(`🔁 Refund to ${addr}:`, web3.utils.fromWei(refundAmount.toString(), "ether"), "ETH");
      }
    });

    dispatch({ type: "SET_AUCTION_DATA", payload: { refundsProcessed: true } });
    await fetchAuctionData();

  } catch (err) {
    setFinalizedClicked(false);
    console.error("❌ Error during finalization:", err);
    toast.error("Auction did not end!\nYou did not get your money for the data!");
  }
}, [state.auction, state.manager, fetchAuctionData]);



  const handleSuccessfulBid = useCallback(
    async (newBidAmount) => {
      console.log("🚨 handleSuccessfulBid triggered", newBidAmount);
      const account = state.connectedAccount?.toLowerCase();
      if (!account || !address) {
         toast.error("Missing account or campaign address");
         console.warn("❌ Missing account or address", account, address);
      }
      try {
          const beforeBudget = await getRemainingBudget();
          console.log("💸 remainingBudget BEFORE update =", beforeBudget);


          setRemainingBudget(beforeBudget);
          console.log("setRemainingBudget called in setRemainingBudget(beforeBudget);")
          const afterBudget = await getRemainingBudget();  
          console.log("💸 remainingBudget AFTER update (should match) =", afterBudget);

          await fetchAuctionData();
      } catch (error) {
        console.log(error.message);
        toast.error("Error updating bid info: " + error.message);
      }
    },
    [address, state.connectedAccount, fetchAuctionData]
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
    if (isAuctionActive) interval = setInterval(fetchAuctionData, 2500); // Update every 2.5 seconds
    return () => interval && clearInterval(interval);
  }, [fetchAuctionData, isAuctionActive]);

useEffect(() => {
  if (!state.auction) return;

  const auction = state.auction;


  fetchAuctionData();  

  // 🟢 Handlers for the events
  const handleRefundProcessed = (contributor, amount) => {
    console.log(`Refund: ${contributor} got ${amount} wei`);
    fetchAuctionData(); // טען מחדש את הדאטה
  };

  const handleSellerPaid = (seller, amount) => {
    console.log(`Seller paid: ${seller} got ${amount} wei`);
    fetchAuctionData(); // גם כאן רענון
  };

  // 🟡 Create subscriptions
  const refundEvent = auction.events.RefundProcessed();
  const sellerPaidEvent = auction.events.SellerPaid();

  refundEvent.on("data", (event) =>
    handleRefundProcessed(event.returnValues.contributor, event.returnValues.amount)
  );

  sellerPaidEvent.on("data", (event) =>
    handleSellerPaid(event.returnValues.seller, event.returnValues.amount)
  );

  // 🔴 Cleanup on unmount!
  return () => {
    refundEvent.unsubscribe();    // ← חובה למנוע דליפות זיכרון
    sellerPaidEvent.unsubscribe();
  };
}, [state.auction]);



  const renderAuctionInfo = () => (
      <DialogActions>

    <Box
    sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}
    
    
    
    >

      <div className={showPageStyles.campaignInfo}>
        <p className={showPageStyles.introductionTitle}>Auction # {address}</p>
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
        <InfoItem label="Highest bid (wei) recorded" value={state.highestBid} />
        <InfoItem label="Number of bidders" value={state.approversCount} />
      </div>



      {!state.refundsProcessed &&
      !finalizedClicked &&
      !isAuctionActive &&
      isManager &&
      state.transactions.length !== 0 && (
        <Button
          id="finalize-auction-button"
          variant="contained"
          disabled={!state.transactions.length}
          style={{ ...buttonStyle, marginTop: "2rem", width: "24rem"}}
          onClick={finalizeAuction}
        >
          Get your money
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
                  variant="outlined"
                  style={{ ...buttonStyle, margin: "1rem 0" }}
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
                : "You did not win the auction. Awaiting refund from the manager."}
            </Typography>
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
          </DialogTitle>
          <DialogContent>
            <DialogContentText>
              {state.transactions.length ? (
                <TableContainer component={Paper}>
                  <Table sx={{ minWidth: 400 }} aria-label="bids">
                    <TableHead>
                      <TableRow>
                        <TableCell className={showPageStyles.headerCell}>
                          Bidder Address
                        </TableCell>
                        <TableCell
                          className={showPageStyles.headerCell}
                          align="center"
                        >
                          Bid Amount
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
                        <TableRow key={index}>
                          <TableCell align="center">{row.bidder}</TableCell>
                          <TableCell align="center">{row.bid}</TableCell>
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
