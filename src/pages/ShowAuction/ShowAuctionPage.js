import moment from "moment";
import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Layout from "./../../components/Layout";
import Campaign from "./../../real_ethereum/campaign";
import ContributeForm from "./../../components/ContributeForm";
import showPageStyles from "./show.module.scss";
import Countdown from "react-countdown";
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
} from "@mui/material";
import GavelIcon from "@mui/icons-material/Gavel";
import ListOutlinedIcon from "@mui/icons-material/ListOutlined";
import KeyboardReturnOutlinedIcon from "@mui/icons-material/KeyboardReturnOutlined";
import CloseIcon from "@mui/icons-material/Close";
import picSrc from "./medal.png";

function ShowAuctionPage() {
  const [state, setState] = useState({
    displayBiddingDialog: false,
    dialogOpen: false,
    minimumContribution: 0,
    approversCount: 0,
    manager: "",
    highestBid: 0,
    dataForSell: "",
    dataDescription: "",
    endTime: 0,
    highestBidder: "",
    connectedAccount: "",
    transactions: [],
    contributors: [],
    auction: null,
  });

  const { address } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchData = async () => {
      const accounts = await window.ethereum.request({
        method: "eth_accounts",
      });
      const auction = Campaign(address);
      const [details, bids, contributors] = await Promise.all([
        auction.methods.getSummary().call(),
        auction.methods.getTransactions().call(),
        auction.methods.getAddresses().call(),
      ]);

      const transactions = bids.map((bid) => ({
        bidder: bid.sellerAddress,
        bid: bid.value,
        time: moment.unix(Number(bid.time)).format("DD-MM-YYYY HH:mm:ss"),
      }));

      setState({
        ...state,
        auction,
        connectedAccount: accounts[0],
        minimumContribution: details[0],
        approversCount: details[2],
        manager: details[3],
        highestBid: details[4],
        dataForSell: details[5],
        dataDescription: details[6],
        endTime: details[7],
        highestBidder: details[8],
        transactions,
        contributors,
      });
    };
    fetchData();
  }, [address]);

  const buttonStyle = {
    width: "15rem",
    height: "2.5rem",
    borderRadius: "1rem",
    backgroundColor: "#103090",
    color: "#D8DCF0",
    fontWeight: "600",
    border: "1px solid #002884",
  };

  const refundApprovers = async () => {
    const isActive = await state.auction.methods.getStatus().call();
    if (!isActive) {
      const refundPromises = state.contributors
        .filter(
          (contributor) =>
            contributor.toLowerCase() !== state.highestBidder.toLowerCase()
        )
        .map((contributor) =>
          state.auction.methods
            .withdrawBid(contributor)
            .send({ from: state.manager })
        );
      await Promise.all(refundPromises);
    } else {
      alert("You already refunded contributing accounts");
    }
  };

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
              <Countdown date={Number(state.endTime + "000")} />
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
      </div>

      {!isAuctionActive && isManager && (
        <Button
          startIcon={<ListOutlinedIcon />}
          variant="contained" // Changed to contained
          style={{ ...buttonStyle, marginTop: "2rem", width: "24rem" }}
          onClick={() => setState({ ...state, dialogOpen: true })}
        >
          Display Bidding History
        </Button>
      )}
      <br />
      <Button
        startIcon={
          isAuctionActive ? <GavelIcon /> : <KeyboardReturnOutlinedIcon />
        }
        onClick={() => navigate("/auctions-list")}
        style={{
          ...buttonStyle,
          marginTop: isAuctionActive ? "6.5rem" : "2rem",
          width: isAuctionActive ? "15rem" : "24rem",
        }}
        variant="contained" // Changed to contained
      >
        {isAuctionActive
          ? "Return To Auctions"
          : "Return To Auctions Main Screen"}
      </Button>
    </Box>
  );

  const isAuctionActive = Number(state.endTime + "000") > Date.now();
  const isManager =
    state.manager.toLowerCase() === state.connectedAccount.toLowerCase();
  const isHighestBidder =
    state.highestBidder.toLowerCase() === state.connectedAccount.toLowerCase();

  return (
    <Layout>
      <div className={showPageStyles.page}>
        {renderAuctionInfo()}
        {isAuctionActive ? (
          !isManager && (
            <div className={showPageStyles.contributeForm}>
              <ContributeForm address={address} />
            </div>
          )
        ) : isHighestBidder ? (
          <div className={showPageStyles.contributeForm}>
            <div className={showPageStyles.centered}>
              <img alt="medal" width={"80px"} src={picSrc} />
              <div className={showPageStyles.winnerTitle}>Congrats!</div>
              <div className={showPageStyles.winnerLabel}>
                You won the auction and have now access to the data
              </div>
              {!state.displayBiddingDialog && (
                <Button
                  onClick={() =>
                    setState({ ...state, displayBiddingDialog: true })
                  }
                  style={{
                    ...buttonStyle,
                    marginTop: "1rem",
                    marginBottom: "1rem",
                  }}
                  variant="outlined"
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
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
          }}
        ></div>
      </div>
      {!isAuctionActive && isManager && (
        <Dialog
          fullWidth
          open={state.dialogOpen}
          onClose={() => setState({ ...state, dialogOpen: false })}
        >
          <DialogTitle>
            <Box
              display="flex"
              justifyContent="flex-start"
              flexDirection={"row-reverse"}
              alignItems="center"
              textAlign={"center"}
              gap={"140px"}
            >
              <Button onClick={() => setState({ ...state, dialogOpen: false })}>
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
                  <Table sx={{ minWidth: 400 }} aria-label="simple table">
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
                        <TableRow
                          key={index}
                          sx={{
                            "&:last-child td, &:last-child th": { border: 0 },
                          }}
                        >
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
              onClick={refundApprovers}
              disabled={!state.transactions.length}
              style={{ ...buttonStyle, marginRight: "1rem", width: "12rem" }}
              autoFocus
            >
              Refund Approvers
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Layout>
  );
}

export default ShowAuctionPage;
