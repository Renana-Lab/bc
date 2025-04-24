import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import moment from "moment";
import Layout from "../../components/Layout";
import Campaign from "../../real_ethereum/campaign";
import ContributeForm from "../../components/ContributeForm";
import Countdown from "react-countdown";
import toast from "react-hot-toast";
import {
  Box, Button, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Paper
} from "@mui/material";
import {
  Gavel as GavelIcon,
  ListOutlined as ListIcon,
  KeyboardReturnOutlined as ReturnIcon,
  Close as CloseIcon
} from "@mui/icons-material";
import showPageStyles from "./show.module.scss";
import picSrc from "./medal.png";

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
  });

  const { address } = useParams();
  const navigate = useNavigate();

  // Derived values
  const isAuctionActive = useMemo(() => Number(state.endTime + "000") > Date.now(), [state.endTime]);
  const isManager = useMemo(() =>
    state.manager?.toLowerCase() === state.connectedAccount?.toLowerCase(), [state.manager, state.connectedAccount]
  );
  const isHighestBidder = useMemo(() =>
    state.highestBidder?.toLowerCase() === state.connectedAccount?.toLowerCase(), [state.highestBidder, state.connectedAccount]
  );

  // Handle refunds
  const refundApprovers = useCallback(async () => {
    const isActive = await state.auction.methods.getStatus().call();
    if (isActive) return toast.error("You already refunded contributing accounts");

    const refundPromises = state.contributors
      .filter((addr) => addr.toLowerCase() !== state.highestBidder.toLowerCase())
      .map((addr) => state.auction.methods.withdrawBid(addr).send({ from: state.manager }));

    await Promise.all(refundPromises);
  }, [state]);

  // Initial fetch
  useEffect(() => {
    if (!window.ethereum) return navigate("/");

    const fetchData = async () => {
      const [accounts, auctionInstance] = await Promise.all([
        window.ethereum.request({ method: "eth_accounts" }),
        Campaign(address)
      ]);

      const [summary, rawTransactions, contributors] = await Promise.all([
        auctionInstance.methods.getSummary().call(),
        auctionInstance.methods.getTransactions().call(),
        auctionInstance.methods.getAddresses().call()
      ]);

      const transactions = rawTransactions.map(({ sellerAddress, value, time }) => ({
        bidder: sellerAddress,
        bid: value,
        time: moment.unix(Number(time)).format("DD-MM-YYYY HH:mm:ss"),
      }));

      setState(prev => ({
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
        transactions,
        contributors
      }));
    };

    fetchData();
  }, [address, navigate]);

  // UI Renders
  const renderAuctionInfo = () => (
    <Box>
      <div className={showPageStyles.campaignInfo}>
        <p className={showPageStyles.introductionTitle}>Auction # {address}</p>
        <hr />
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>Data description: </span>
          <span className={showPageStyles.introductionText}>{state.dataDescription}</span>
        </p>
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>Seller address: </span>
          <span className={showPageStyles.introductionText}>{state.manager}</span>
        </p>
        {isAuctionActive && (
          <p className={showPageStyles.introductionDetail}>
            <span className={showPageStyles.introductionLabel}>Time left: </span>
            <span className={showPageStyles.introductionText}>
              <Countdown date={Number(state.endTime + "000")} />
            </span>
          </p>
        )}
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>Minimum bid (wei) required: </span>
          <span className={showPageStyles.introductionText}>{state.minimumContribution}</span>
        </p>
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>Highest bid (wei) recorded: </span>
          <span className={showPageStyles.introductionText}>{state.highestBid}</span>
        </p>
        <p className={showPageStyles.introductionDetail}>
          <span className={showPageStyles.introductionLabel}>Number of bidders: </span>
          <span className={showPageStyles.introductionText}>{state.approversCount}</span>
        </p>
      </div>

      {!isAuctionActive && isManager && (
        <Button
          startIcon={<ListIcon />}
          variant="contained"
          style={{ ...buttonStyle, marginTop: "2rem", width: "24rem" }}
          onClick={() => setState(prev => ({ ...prev, dialogOpen: true }))}
        >
          Display Bidding History
        </Button>
      )}

      <br />

      <Button
        startIcon={isAuctionActive ? <GavelIcon /> : <ReturnIcon />}
        onClick={() => navigate("/auctions-list")}
        style={{
          ...buttonStyle,
          marginTop: isAuctionActive ? "6.5rem" : "2rem",
          width: isAuctionActive ? "15rem" : "24rem",
          marginBottom: "2rem"
        }}
        variant="contained"
      >
        {isAuctionActive ? "Return To Auctions" : "Return To Auctions Main Screen"}
      </Button>
    </Box>
  );

  return (
    <Layout>
      <div className={showPageStyles.page}>
        {renderAuctionInfo()}

        {isAuctionActive && !isManager ? (
          <div className={showPageStyles.contributeForm}>
            <ContributeForm address={address} />
          </div>
        ):null}

        {!isAuctionActive && isHighestBidder ? (
          <div className={showPageStyles.contributeForm}>
            <div className={showPageStyles.centered}>
              <img alt="medal" width={"80px"} src={picSrc} />
              <div className={showPageStyles.winnerTitle}>Congrats!</div>
              <div className={showPageStyles.winnerLabel}>
                You won the auction and have now access to the data
              </div>
              {!state.displayBiddingDialog && (
                <Button
                  variant="outlined"
                  style={{ ...buttonStyle, margin: "1rem 0" }}
                  onClick={() => setState(prev => ({ ...prev, displayBiddingDialog: true }))}
                >
                  View Data
                </Button>
              )}
            </div>
            {state.displayBiddingDialog && (
              <div className={showPageStyles.revealedData}>
                <p className={showPageStyles.introductionDetail}>
                  <span className={showPageStyles.introductionLabel}>Data Description: </span>
                  <span className={showPageStyles.introductionText}>{state.dataDescription}</span>
                </p>
                <p className={showPageStyles.introductionDetail}>
                  <span className={showPageStyles.introductionLabel}>Data acquired: </span>
                  <span className={showPageStyles.introductionText}>{state.dataForSell}</span>
                </p>
              </div>
            )}
          </div>
        ):null}
      </div>

      {!isAuctionActive && isManager ? (
        <Dialog fullWidth open={state.dialogOpen} onClose={() => setState(prev => ({ ...prev, dialogOpen: false }))}>
          <DialogTitle>
            <Box display="flex" justifyContent="flex-start" flexDirection="row-reverse" alignItems="center" gap="140px">
              <Button onClick={() => setState(prev => ({ ...prev, dialogOpen: false }))}>
                <CloseIcon sx={{ color: "black", background: "#9090D0", borderRadius: "20px", padding: "4px" }} />
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
                        <TableCell className={showPageStyles.headerCell}>Bidder Address</TableCell>
                        <TableCell className={showPageStyles.headerCell} align="center">Bid Amount</TableCell>
                        <TableCell className={showPageStyles.headerCell} align="center">Bid Time</TableCell>
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
              disabled={!state.transactions.length}
              style={{ ...buttonStyle, marginRight: "1rem", width: "12rem" }}
              onClick={refundApprovers}
              autoFocus
            >
              Refund Approvers
            </Button>
          </DialogActions>
        </Dialog>
      ):null}
    </Layout>
  );
}

export default ShowAuctionPage;
