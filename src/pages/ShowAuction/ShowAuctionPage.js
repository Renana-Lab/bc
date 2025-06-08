import { useReducer, useEffect, useMemo, useCallback, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import moment from "moment";
import Layout from "../../components/Layout";
import Campaign from "../../real_ethereum/campaign";
import ContributeForm from "../../components/ContributeForm";
import Countdown from "react-countdown";
import toast from "react-hot-toast";
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
    dispatch({ type: "SET_LOADING" });
    try {
      const [accounts, auctionInstance] = await Promise.all([
        window.ethereum.request({ method: "eth_accounts" }),
        Campaign(address),
      ]);
      const [summary, rawTransactions, contributors, userBid, isActive] =
        await Promise.all([
          auctionInstance.methods.getSummary().call(),
          auctionInstance.methods.getTransactions().call(),
          auctionInstance.methods.getAddresses().call(),
          accounts[0]
            ? auctionInstance.methods.getBid(accounts[0]).call()
            : Promise.resolve(0),
          auctionInstance.methods.getStatus().call(),
        ]);
      const transactions = rawTransactions.map(
        ({ sellerAddress, value, time }) => ({
          bidder: sellerAddress,
          bid: value,
          time: moment.unix(Number(time)).format("DD-MM-YYYY HH:mm:ss"),
        })
      );
      let refundsProcessed = true;
      if (!isActive) {
        for (const contributor of contributors) {
          if (contributor.toLowerCase() !== summary[8].toLowerCase()) {
            const balance = await auctionInstance.methods
              .getBid(contributor)
              .call();
            if (Number(balance) > 0) {
              refundsProcessed = false;
              break;
            }
          }
        }
      }
      dispatch({
        type: "SET_AUCTION_DATA",
        payload: {
          connectedAccount: accounts[0] || "",
          auction: auctionInstance,
          minimumContribution: summary[0],
          approversCount: summary[2],
          manager: summary[3],
          highestBid: summary[4],
          dataForSell: summary[5],
          dataDescription: summary[6],
          endTime: summary[7],
          highestBidder: summary[8],
          transactions,
          contributors,
          refundsProcessed,
          userBid: Number(userBid),
        },
      });
      if (accounts[0])
        setRemainingBudget(await getRemainingBudget(accounts[0].toLowerCase()));
    } catch (err) {
      console.error(err);
      dispatch({ type: "SET_ERROR", payload: "Error fetching auction data" });
      toast.error("Error fetching auction data");
    }
  }, [address, navigate]);

  const refundApprovers = useCallback(async () => {
    if (!state.auction) return;
    try {
      const isActive = await state.auction.methods.getStatus().call();
      if (isActive)
        return toast.error("Auction still active, cannot refund yet.");
      const nonWinners = state.contributors.filter(
        (addr) => addr.toLowerCase() !== state.highestBidder.toLowerCase()
      );
      for (const addr of nonWinners) {
        const bidAmount = await state.auction.methods.getBid(addr).call();
        if (Number(bidAmount) > 0)
          await state.auction.methods
            .withdrawBid(addr)
            .send({ from: state.manager });
      }
      await state.auction.methods.paySeller().send({ from: state.manager });
      toast.success("Refunds processed and seller paid!");
      await fetchAuctionData();
    } catch (err) {
      console.error(err);
      toast.error("Error processing refunds: " + err.message);
    }
  }, [
    state.auction,
    state.contributors,
    state.highestBidder,
    state.manager,
    fetchAuctionData,
  ]);

  const handleSuccessfulBid = useCallback(
    async (newBidAmount) => {
      const account = state.connectedAccount?.toLowerCase();
      if (!account || !address)
        return toast.error("Missing account or campaign address");
      try {
        const campaign = Campaign(address);
        const previousBid = Number(
          await campaign.methods.getBid(account).call()
        );
        const difference = newBidAmount - previousBid;
        if (difference > 0) {
          await addUserSpending(account, difference);
          setRemainingBudget(await getRemainingBudget(account));
          await fetchAuctionData();
        }
      } catch (error) {
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

  // useEffect(() => {
  //   if (!isAuctionActive) {
  //     console.log("Handling auction end for manager...");
  //     try {
  //       refundApprovers().finally(() => {
  //         setHasHandledAuctionEnd(true); // prevent double execution
  //         console.log("Handled!");
  //       });
  //     } catch (error) {
  //       console.error("Error handling auction end:", error);
  //     }
  //   }
  // }, [
  //   isAuctionActive,
  //   isManager,
  //   state.refundsProcessed,
  //   refundApprovers,
  //   hasHandledAuctionEnd,
  // ]);

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
            <Button
              variant="contained"
              disabled={!state.transactions.length || state.refundsProcessed}
              style={{ ...buttonStyle, marginRight: "1rem", width: "12rem" }}
              onClick={refundApprovers}
            >
              {state.refundsProcessed
                ? "Refunds Processed"
                : "Refund Approvers"}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Layout>
  );
}

export default ShowAuctionPage;
