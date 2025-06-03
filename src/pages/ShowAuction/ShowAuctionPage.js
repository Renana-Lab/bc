import React, { useState, useEffect, useMemo, useCallback } from "react";
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
} from "@mui/material";
import {
  Gavel as GavelIcon,
  ListOutlined as ListIcon,
  KeyboardReturnOutlined as ReturnIcon,
  Close as CloseIcon,
  MoneyOff as MoneyOffIcon,
} from "@mui/icons-material";
import showPageStyles from "./show.module.scss";
import picSrc from "./medal.png";
import {
  getRemainingBudget,
  addUserSpending,
  reduceUserSpending,
} from "../AuctionsList/AuctionsListPage";

const buttonStyle = {
  height: "2.5rem",
  borderRadius: "1rem",
  backgroundColor: "#103090",
  color: "#D8DCF0",
  fontWeight: "600",
  border: "1px solid #002884",
};

function ShowAuctionPage() {
  const [state, setState] = useState({
    displayBiddingDialog: false,
    dialogOpen: false,
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
    contractBalance: 0,
    auctionEnded: false, // Add auctionEnded to state
  });

  const { address } = useParams();
  const navigate = useNavigate();
  const { state: navState } = useLocation();
  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || 0
  );

  const isAuctionActive = useMemo(
    () => Number(state.endTime + "000") > Date.now() && !state.auctionEnded,
    [state.endTime, state.auctionEnded]
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

      const [summary, rawTransactions, contributors] = await Promise.all([
        auctionInstance.methods.getSummary().call(),
        auctionInstance.methods.getTransactions().call(),
        auctionInstance.methods.getAddresses().call(),
      ]);

      const transactions = rawTransactions.map(
        ({ sellerAddress, value, time }) => ({
          bidder: sellerAddress,
          bid: value,
          time: moment.unix(Number(time)).format("DD-MM-YYYY HH:mm:ss"),
        })
      );

      const balance = await window.ethereum.request({
        method: "eth_getBalance",
        params: [address, "latest"],
      });
      const contractBalance = Number(balance) / 10 ** 18; // Convert wei to ether

      let refundsProcessed = true;
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

      let currentUserBid = 0;
      if (accounts[0]) {
        currentUserBid = await auctionInstance.methods
          .getBid(accounts[0])
          .call();
      }

      setState((prev) => ({
        ...prev,
        connectedAccount: accounts[0],
        auction: auctionInstance,
        minimumContribution: summary[0],
        approversCount: summary[2],
        manager: summary[3],
        highestBid: summary[4],
        dataForSell: summary[5],
        dataDescription: summary[6],
        endTime: summary[7],
        highestBidder: summary[8],
        auctionEnded: summary[9], // Fetch auctionEnded
        transactions,
        contributors,
        refundsProcessed,
        contractBalance,
        userBid: Number(currentUserBid),
      }));

      setRemainingBudget(getRemainingBudget(accounts[0].toLowerCase()));
    } catch (err) {
      console.error(err);
      toast.error("Error fetching auction data");
    }
  }, [address, navigate]);

  useEffect(() => {
    fetchAuctionData();
    const interval = setInterval(fetchAuctionData, 10000);
    return () => clearInterval(interval);
  }, [fetchAuctionData]);

  const refundApprovers = useCallback(async () => {
    if (!isManager) {
      toast.error("Only the manager can process refunds");
      return;
    }

    try {
      const isActive = await state.auction.methods.isAuctionActive().call();
      if (isActive) {
        toast.error("Auction still active, cannot refund yet.");
        return;
      }

      const refundPromises = state.contributors
        .filter(
          (addr) => addr.toLowerCase() !== state.highestBidder.toLowerCase()
        )
        .map(async (addr) => {
          const bidAmount = await state.auction.methods.getBid(addr).call();
          if (Number(bidAmount) > 0) {
            await state.auction.methods
              .withdrawBid(addr)
              .send({ from: state.connectedAccount });
            reduceUserSpending(addr.toLowerCase(), Number(bidAmount));
            if (addr.toLowerCase() === state.connectedAccount.toLowerCase()) {
              setRemainingBudget(
                getRemainingBudget(state.connectedAccount.toLowerCase())
              );
            }
          }
        });

      await Promise.all(refundPromises);
      toast.success("Refunds processed for non-winning bidders!");
      setState((prev) => ({ ...prev, refundsProcessed: true }));
      fetchAuctionData();
    } catch (err) {
      console.error(err);
      toast.error("Error processing refunds: " + err.message);
    }
  }, [state, isManager, fetchAuctionData]);

  const handleSuccessfulBid = async (newBidAmount, address) => {
    const account = state.connectedAccount?.toLowerCase();
    if (!account || !address) {
      toast.error("Missing account or campaign address");
      return;
    }

    try {
      const campaign = Campaign(address);
      const previousBidStr = await campaign.methods.getBid(account).call();
      const previousBid = Number(previousBidStr);
      const difference = newBidAmount - previousBid;

      if (difference > 0) {
        await addUserSpending(account, difference);
        const updatedBudget = await getRemainingBudget(account);
        setRemainingBudget(updatedBudget);
        await fetchAuctionData();
      } else {
        toast("No additional spending recorded (bid was same or lower)");
      }
    } catch (error) {
      toast.error("Error updating bid info: " + error.message);
    }
  };

  const endAuction = useCallback(async () => {
    if (!isManager) {
      toast.error("Only the manager can end the auction");
      return;
    }
    try {
      await state.auction.methods
        .endAuction()
        .send({ from: state.connectedAccount });
      toast.success("Auction ended successfully!");
      fetchAuctionData();
    } catch (err) {
      console.error(err);
      toast.error("Error ending auction: " + err.message);
    }
  }, [state, isManager, fetchAuctionData]);

  const withdrawRemainingFunds = useCallback(async () => {
    if (!isManager) {
      toast.error("Only the manager can withdraw remaining funds");
      return;
    }
    try {
      await state.auction.methods
        .withdrawRemainingFunds()
        .send({ from: state.connectedAccount });
      toast.success("Remaining funds withdrawn successfully!");
      fetchAuctionData();
    } catch (err) {
      console.error(err);
      toast.error("Error withdrawing funds: " + err.message);
    }
  }, [state, isManager, fetchAuctionData]);

  const renderAuctionInfo = () => (
    <Box>
      <div className={showPageStyles.campaignInfo}>
        <p className={showPageStyles.introductionTitle}>Auction # {address}</p>
        <hr />
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>
            Data description:{" "}
          </span>
          <span className={showPageStyles.introductionText}>
            {state.dataDescription}
          </span>
        </p>
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>
            Seller address:{" "}
          </span>
          <span className={showPageStyles.introductionText}>
            {state.manager}
          </span>
        </p>
        {isAuctionActive && (
          <p className={showPageStyles.introductionDetail}>
            <span className={showPageStyles.introductionLabel}>
              Time left:{" "}
            </span>
            <span className={showPageStyles.introductionText}>
              <Countdown
                date={Number(state.endTime + "000")}
                onComplete={() => {
                  if (!state.refundsProcessed && isManager) {
                    refundApprovers();
                  }
                  fetchAuctionData();
                }}
              />
            </span>
          </p>
        )}
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>
            Minimum bid (wei) required:{" "}
          </span>
          <span className={showPageStyles.introductionText}>
            {state.minimumContribution}
          </span>
        </p>
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>
            Highest bid (wei) recorded:{" "}
          </span>
          <span className={showPageStyles.introductionText}>
            {state.highestBid}
          </span>
        </p>
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>
            Number of bidders:{" "}
          </span>
          <span className={showPageStyles.introductionText}>
            {state.approversCount}
          </span>
        </p>
        {!isAuctionActive && (
          <p className={showPageStyles.introductionDetail}>
            <span className={showPageStyles.introductionLabel}>
              Contract Balance (wei):{" "}
            </span>
            <span className={showPageStyles.introductionText}>
              {state.contractBalance}
            </span>
          </p>
        )}
      </div>

      {!isAuctionActive && isManager && (
        <>
          <Button
            startIcon={<ListIcon />}
            variant="contained"
            style={{ ...buttonStyle, marginTop: "2rem", width: "24rem" }}
            onClick={() => setState((prev) => ({ ...prev, dialogOpen: true }))}
          >
            Display Bidding History
          </Button>
          <Button
            startIcon={<GavelIcon />}
            variant="contained"
            style={{ ...buttonStyle, marginTop: "1rem", width: "24rem" }}
            onClick={endAuction}
            disabled={state.auctionEnded} // Use state.auctionEnded
          >
            End Auction
          </Button>
          {state.contractBalance > 0 && (
            <Button
              startIcon={<MoneyOffIcon />}
              variant="contained"
              style={{ ...buttonStyle, marginTop: "1rem", width: "24rem" }}
              onClick={withdrawRemainingFunds}
            >
              Withdraw Remaining Funds
            </Button>
          )}
        </>
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
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      displayBiddingDialog: true,
                    }))
                  }
                >
                  View Data
                </Button>
              )}
            </div>
            {state.displayBiddingDialog && (
              <div className={showPageStyles.revealedData}>
                <p className={showPageStyles.introductionDetail}>
                  <span className={showPageStyles.introductionLabel}>
                    Data Description:{" "}
                  </span>
                  <span className={showPageStyles.introductionText}>
                    {state.dataDescription}
                  </span>
                </p>
                <p className={showPageStyles.introductionDetail}>
                  <span className={showPageStyles.introductionLabel}>
                    Data acquired:{" "}
                  </span>
                  <span className={showPageStyles.introductionText}>
                    {state.dataForSell}
                  </span>
                </p>
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
          onClose={() => setState((prev) => ({ ...prev, dialogOpen: false }))}
        >
          <DialogTitle>
            <Box
              display="flex"
              justifyContent="flex-start"
              flexDirection="row-reverse"
              alignItems="center"
              gap="140px"
            >
              <Button
                onClick={() =>
                  setState((prev) => ({ ...prev, dialogOpen: false }))
                }
              >
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
                          <TableCell align="center">{row.index}</TableCell>
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
              autoFocus
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
