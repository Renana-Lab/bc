import * as moment from "moment";
import React, { useState, useEffect } from "react";
import Layout from "./../../components/Layout";
import Campaign from "./../../real_ethereum/campaign";
import ContributeForm from "./../../components/ContributeForm";
import showPageStyles from "./show.module.scss";
import Countdown from "react-countdown";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Paper from "@mui/material/Paper";
import { useParams, useNavigate } from "react-router-dom";

function ShowAuctionPage() {
  const [displayBiddingDialog, setDisplayBiddingDialog] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [minimumContribution, setMinimumContribution] = useState(0);
  const [approversCount, setApproversCount] = useState(0);
  const [manager, setManager] = useState("");
  const [highestBid, setHighestBid] = useState(0);
  const [dataForSell, setDataForSell] = useState("");
  const [dataDescription, setDataDescription] = useState("");
  const [endTime, setEndTime] = useState(0);
  const [highestBidder, setHighestBidder] = useState("");
  const [connectedAccount, setConnectedAccount] = useState("");
  const [transactions, setTransactions] = useState([]);
  const [contributors, setContributors] = useState([]);
  const [auction, setAuction] = useState(null);
  const { address } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchData = async () => {
      const accounts = await window.ethereum.request({
        method: "eth_accounts",
      });
      const connectedAccount = accounts[0];

      const auction = Campaign(address);
      setAuction(auction);
      const auctionDetails = await auction.methods.getSummary().call();
      const bids = await auction.methods.getTransactions().call();
      const contributors = await auction.methods.getAddresses().call();
      let transactions = [];
      for (let i = 0; i < bids.length; i++) {
        let obj = {
          bidder: bids[i].sellerAddress,
          bid: bids[i].value,
          time: moment.unix(Number(bids[i].time)).format("DD-MM-YYYY HH:mm:ss"),
        };
        transactions.push(obj);
      }
      setMinimumContribution(auctionDetails[0]);
      setApproversCount(auctionDetails[2]);
      setManager(auctionDetails[3]);
      setHighestBid(auctionDetails[4]);
      setDataForSell(auctionDetails[5]);
      setDataDescription(auctionDetails[6]);
      setEndTime(auctionDetails[7]);
      setHighestBidder(auctionDetails[8]);
      setConnectedAccount(connectedAccount);
      setTransactions(transactions);
      setContributors(contributors);
    };
    fetchData();
  }, [address]);
  const handleClickOpen = () => {
    setDialogOpen(true);
  };
  const handleClose = () => {
    setDialogOpen(false);
  };
  const showData = (event) => {
    setDisplayBiddingDialog(true);
  };
  const refundApprovers = async () => {
    if (!auction.methods.getStatus().call()) {
      for (let i = 0; i < contributors.length; i++) {
        if (contributors[i].toLowerCase() !== highestBidder.toLowerCase()) {
          let connectedAccount = contributors[i];
          await auction.methods.withdrawBid(connectedAccount).send({
            from: manager,
          });
        }
      }
    } else {
      alert("You already refund contribute accounts");
    }
  };
  return Number({ endTime } + "000") > Date.now() ? (
    // if auction is still running
    <Layout>
      <div className={showPageStyles.page}>
        <div className={showPageStyles.campaignInfo}>
          <div>
            <p className={showPageStyles.introductionTitle}>
              Auction # {address}
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Data description :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {dataDescription}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Seller address :{" "}
              </span>
              <span className={showPageStyles.introductionText}>{manager}</span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Time left :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {" "}
                <Countdown date={Number(endTime + "000")} />
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Minimum bid (wei) required :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {minimumContribution}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Highest bid (wei) recorded :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {highestBid}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Number of bidders :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {approversCount}
              </span>
            </p>
          </div>
        </div>
        {/* If not manager is connected */}
        {manager.toLowerCase() !== connectedAccount.toLowerCase() && (
          <div className={showPageStyles.contributeForm}>
            <ContributeForm address={address} />
          </div>
        )}
      </div>
      {/* <Link route={`/auctions-list`}> */}
      <Button
      onClick={() => window.location.href = "/auctions-list"}
        style={{
          marginTop: "6.5rem",
          float: "left",
          width: "15rem",
          height: "2.5rem",
          borderRadius: "1rem",
          backgroundColor: "#002884",
          color: "#D8DCF0",
          fontWeight: "600",
          border: "1px solid #002884",
        }}
        variant="outlined"
      >
        Return To Auctions
      </Button>
      {/* </Link> */}
    </Layout>
  ) : // if connected as highest bidder AND auction is closed
  highestBidder.toLowerCase() === connectedAccount.toLowerCase() ? (
    <Layout>
      <div className={showPageStyles.page}>
        <div className={showPageStyles.campaignInfo}>
          <div>
            <p className={showPageStyles.introductionTitle}>
              Auction # {address}
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Data description :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {dataDescription}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Seller address :{" "}
              </span>
              <span className={showPageStyles.introductionText}>{manager}</span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Minimum bid (wei) required :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {minimumContribution}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Highest bid (wei) recorded :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {highestBid}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Number of bidders :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {approversCount}
              </span>
            </p>
          </div>
        </div>
        <div className={showPageStyles.contributeForm}>
          <div className={showPageStyles.centered}>
            <div className={showPageStyles.winnerTitle}>Congrats !</div>
            <div className={showPageStyles.winnerLabel}>
              You won the auction and have now access to the data
            </div>
            {!{ displayBiddingDialog } && (
              <Button
                onClick={showData}
                style={{
                  marginTop: "1rem",
                  marginBottom: "1rem",
                  width: "15rem",
                  height: "2.5rem",
                  borderRadius: "1rem",
                  backgroundColor: "#002884",
                  color: "#D8DCF0",
                  fontWeight: "600",
                  border: "1px solid #002884",
                }}
                variant="outlined"
              >
                View Data
              </Button>
            )}
          </div>
          {{ displayBiddingDialog } && (
            <div className={showPageStyles.revealedData}>
              {" "}
              <p className={showPageStyles.introductionDetail}>
                <span className={showPageStyles.introductionLabel}>
                  Data Description :{" "}
                </span>
                <span className={showPageStyles.introductionText}>
                  {dataDescription}
                </span>
              </p>
              <p className={showPageStyles.introductionDetail}>
                <span className={showPageStyles.introductionLabel}>
                  Data acquired :{" "}
                </span>
                <span className={showPageStyles.introductionText}>
                  {dataForSell}
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
      {/* <Link route={`/auctions-list`}> */}
      <Button
        style={{
          marginTop: "5rem",
          float: "left",
          width: "15rem",
          height: "2.5rem",
          borderRadius: "1rem",
          backgroundColor: "#002884",
          color: "#D8DCF0",
          fontWeight: "600",
          border: "1px solid #002884",
        }}
        variant="outlined"
      >
        Return To Auctions
      </Button>
      {/* </Link> */}
    </Layout>
  ) : (
    // if not connected as highest bidder AND auction is closed
    <Layout>
      <div className={showPageStyles.page}>
        <div className={showPageStyles.campaignInfo}>
          <div>
            <p className={showPageStyles.introductionTitle}>
              Auction # {address}
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Data description :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {dataDescription}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Seller address :{" "}
              </span>
              <span className={showPageStyles.introductionText}>{manager}</span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Minimum id (wei) required :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {minimumContribution}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Highest id (wei) recorded :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {highestBid}
              </span>
            </p>
            <p className={showPageStyles.introductionDetail}>
              <span className={showPageStyles.introductionLabel}>
                Number of bidders :{" "}
              </span>
              <span className={showPageStyles.introductionText}>
                {approversCount}
              </span>
            </p>
          </div>
        </div>
      </div>
      <div className={showPageStyles.flex}>
        {/* in case we are logged as manager we have access to bidding history */}
        {manager.toLowerCase() === connectedAccount.toLowerCase() && (
          <div>
            <Button
              variant="outlined"
              style={{
                marginTop: "4rem",
                float: "left",
                width: "20rem",
                height: "2.5rem",
                borderRadius: "1rem",
                backgroundColor: "#002884",
                color: "#D8DCF0",
                fontWeight: "600",
                border: "1px solid #002884",
              }}
              onClick={handleClickOpen}
            >
              Display Bidding history
            </Button>
            <Dialog
              open={dialogOpen}
              onClose={handleClose}
              aria-labelledby="alert-dialog-title"
              aria-describedby="alert-dialog-description"
            >
              <DialogTitle id="alert-dialog-title">
                <p className={showPageStyles.title}>Bidding History</p>
                <p className={showPageStyles.title}>Auction # {address} </p>
              </DialogTitle>
              <DialogContent>
                <DialogContentText id="alert-dialog-description">
                  {transactions.length ? (
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
                            <TableCell align="right"></TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {transactions.map((row, index) => (
                            <TableRow
                              className={index % 2 === 0 ? "even" : "odd"}
                              key={index}
                              sx={{
                                "&:last-child td, &:last-child th": {
                                  border: 0,
                                },
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
                    <span>No one contributed to this auction !</span>
                  )}
                </DialogContentText>
              </DialogContent>
              <DialogActions>
                <Button
                  onClick={handleClose}
                  style={{
                    marginRight: "1rem",
                    width: "8rem",
                    height: "2.5rem",
                    borderRadius: "1rem",
                    backgroundColor: "#002884",
                    color: "#D8DCF0",
                    fontWeight: "600",
                    border: "1px solid #002884",
                  }}
                  autoFocus
                >
                  Close
                </Button>
                <Button
                  onClick={refundApprovers}
                  disabled={!transactions.length}
                  style={{
                    marginRight: "1rem",
                    width: "12rem",
                    height: "2.5rem",
                    borderRadius: "1rem",
                    backgroundColor: "#002884",
                    color: "#D8DCF0",
                    fontWeight: "600",
                    border: "1px solid #002884",
                  }}
                  autoFocus
                >
                  Refund Approvers
                </Button>
              </DialogActions>
            </Dialog>
          </div>
        )}
        {/* <Link route={`/auctions-list`}> */}
        <Button onClick={() =>navigate(`/auctions-list`)}
          style={{
            marginTop: "2rem",
            float: "left",
            width: "20rem",
            height: "2.5rem",
            borderRadius: "1rem",
            backgroundColor: "#002884",
            color: "#D8DCF0",
            fontWeight: "600",
            border: "1px solid #002884",
          }}
          variant="outlined"
        >
          Return To Auctions Main Screen
        </Button>
        {/* </Link> */}
      </div>
    </Layout>
  );
}
export default ShowAuctionPage;
