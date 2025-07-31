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
  addUserSpending,
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
    const [accounts, auctionInstance] = await Promise.all([
      window.ethereum.request({ method: "eth_accounts" }),
      Campaign(address),
    ]);

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

    const transactions = rawTransactions.map(({ bidderAddress, value, time }) => ({
      bidder: bidderAddress,
      bid: value,
      time: moment.unix(Number(time)).format("DD-MM-YYYY HH:mm:ss"),
    }));

    let refundsProcessed = true;

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
      setRemainingBudget(getRemainingBudget(account.toLowerCase()));
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
    console.log("⏳ Finalizing auction from:", state.manager);
    const summaryBefore = await state.auction.methods.getSummary().call();
    const addresses = await state.auction.methods.getAddresses().call();

    const balancesBefore = await Promise.all(
      addresses.map(addr => web3.eth.getBalance(addr))
    );
    const managerBalanceBefore = await web3.eth.getBalance(state.manager);

    await state.auction.methods.finalizeAuctionIfNeeded().send({ from: state.manager });

    const managerBalanceAfter = await web3.eth.getBalance(state.manager);

    toast.success(`Auction finalized! Seller earned: ${
      web3.utils.fromWei((BigInt(managerBalanceAfter) - BigInt(managerBalanceBefore)).toString(), "ether")
    } ETH `);
 
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
        // console.log("trying...");
        // const campaign = Campaign(address);
        // const previousBid = Number(
          // await campaign.methods.getBid(account).call()
        // );
        // console.log("previousBid = ", previousBid);
        // console.log("newBidAmount = ", newBidAmount);
        // const difference = newBidAmount - previousBid;
        // console.log("difference = ", difference)
          // console.log("difference > 0...");

          await addUserSpending(account, newBidAmount);
          const beforeBudget = await getRemainingBudget(account);
          console.log("💸 remainingBudget BEFORE update =", beforeBudget);

          setRemainingBudget(beforeBudget);
          const afterBudget = await getRemainingBudget(account);  
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

    const handleRefundProcessed = (contributor, amount) => {
      toast.success(`Refund processed for ${contributor}: ${amount} wei`);
      fetchAuctionData();
    };

    const handleSellerPaid = (seller, amount) => {
      toast.success(`Seller paid: ${amount} wei`);
      fetchAuctionData();
    };

    const refundEvent = state.auction.events.RefundProcessed();
    const sellerPaidEvent = state.auction.events.SellerPaid();

    refundEvent.on("data", (event) =>
      handleRefundProcessed(event.returnValues.contributor, event.returnValues.amount)
    );
    sellerPaidEvent.on("data", (event) =>
      handleSellerPaid(event.returnValues.seller, event.returnValues.amount)
    );

    return () => {
      refundEvent.unsubscribe();
      sellerPaidEvent.unsubscribe();
    };
  }, [state.auction, fetchAuctionData]);


  const renderAuctionInfo = () => (
    <Box>
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
          marginTop: isAuctionActive ? "6.5rem" : "2rem",
          width: isAuctionActive ? "15rem" : "24rem",
          marginBottom: "2rem",
        }}
        variant="contained"
      >
        {isAuctionActive
          ? "Return To Auctions"
          : "Return To Auctions Main Screen"}
      </Button>
    </Box>
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
          <DialogActions>
            {state.refundsProcessed && (
              <Button
                id="finalize-auction-button"
                variant="contained"
                disabled={!state.transactions.length}
                style={{ ...buttonStyle, marginRight: "1rem", width: "12rem" }}
                onClick={finalizeAuction}
              >
                Get your money
              </Button>
            )}
          </DialogActions>
        </Dialog>
      )}
    </Layout>
  );
}

export default ShowAuctionPage;
