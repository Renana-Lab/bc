import React, { useState, useEffect } from "react";
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
  Typography,
  Box,
} from "@mui/material";
import { useNavigate, useLocation } from "react-router-dom";
import Countdown from "react-countdown";
import factory from "../../real_ethereum/factory";
import Campaign from "../../real_ethereum/campaign";
import web3 from "../../real_ethereum/web3";
import Layout from "../../components/Layout";
import styles from "./auctions.module.scss";
import picSrc from "./Illustration_Start.png";
import { getDefaultBudget } from "../ManageBudget/ManageBudgetPage";

// Initialize userSpendingStore from localStorage
export const userSpendingStore = JSON.parse(localStorage.getItem("userSpendingStore")) || {};

export const userAddress = window.ethereum?.selectedAddress?.toLowerCase();


export const getRemainingBudget = (userAddress) => {
  const defaultBudget = getDefaultBudget();
  if (defaultBudget === 0) return Infinity;
  const spent = userSpendingStore[userAddress]?.totalSpent || 0;
  return defaultBudget - spent;
};

export const addUserSpending = (userAddress, amount) => {
  if (!userSpendingStore[userAddress]) {
    userSpendingStore[userAddress] = { totalSpent: 0 };
  }
  userSpendingStore[userAddress].totalSpent += Number(amount);
  localStorage.setItem("userSpendingStore", JSON.stringify(userSpendingStore));
};

export const reduceUserSpending = (userAddress, amount) => {
  if (userSpendingStore[userAddress]) {
    userSpendingStore[userAddress].totalSpent = Math.max(0, userSpendingStore[userAddress].totalSpent - Number(amount));
    localStorage.setItem("userSpendingStore", JSON.stringify(userSpendingStore));
  }
};

function AuctionsListPage() {
  const navigate = useNavigate();
  const { state: navState } = useLocation();
  const [auctionsList, setAuctionsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [remainingBudget, setRemainingBudget] = useState(
    navState?.remainingBudget || (getDefaultBudget() === 0 ? Infinity : getDefaultBudget())
  );

  const fetchNetworkId = async () => {
    try {
      const id = await web3.eth.net.getId();
      // console.log("✅ Connected Network ID:", id);
    } catch (error) {
      console.error("❌ Error fetching network ID:", error);
    }
  };


  const fetchAuctionsList = async () => { 
    try {
      const auctions = await factory.methods.getDeployedCampaigns().call();
      const auctionData = await Promise.all(
        auctions.map(async (address) => {
          const auction = Campaign(address);
          const details = await auction.methods.getSummary().call();
          const addresses = await auction.methods.getAddresses().call();
          const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();

          let isRefunded = false;
          const auctionEnded = Number(details[9] + "000") < Date.now();
          // console.log(auctionEnded);
          const isHighestBidder = details[7].toLowerCase() === currentUserAddress;
          const isManager = details[3].toLowerCase() === currentUserAddress;
          const userInAuction = addresses.map(a => a.toLowerCase()).includes(currentUserAddress);

          if (userInAuction && auctionEnded && !isHighestBidder && !isManager) {
            const balance = await auction.methods.getBid(currentUserAddress).call();
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
              addresses: details[8],
              endTime: Number(details[9] + "000"), // ← אל תשכח להכפיל ב-1000
              isRefunded,

            };
        })
      );
      setAuctionsList(auctionData);
    } catch (error) {
      console.error("❌ Error fetching auctions:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!window.ethereum) {
      navigate("/");
    } else {
      const userAddress = window.ethereum.selectedAddress?.toLowerCase();
      setCurrentUser(userAddress);
      setRemainingBudget(getRemainingBudget(userAddress));

      fetchNetworkId();
      fetchAuctionsList();

      const interval = setInterval(() => {
        fetchAuctionsList();
        setRemainingBudget(getRemainingBudget(userAddress));
        // console.log("⏰ Fe tching auctions list...");
      }, 1000);

      return () => clearInterval(interval);
    }
  }, []);

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
    console.log(currentUserAddress, `is the higestbider in ${auction.address} ?`, auction.highestBidder?. toLowerCase() === currentUserAddress);
    return auction.highestBidder?. toLowerCase() === currentUserAddress;
  }


  const hasUserWonAuction = (auction) => {
    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
    const auctionEnded = Number(auction.endTime) < Date.now();
    const _isHighestBidder = isHighestBidder(auction, currentUserAddress);
    return auctionEnded && _isHighestBidder;
  };

  const isUserInAuction = (auction) => {
    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
    return !!auction?.addresses?.some(
      (address) => address.toLowerCase() === currentUserAddress
    );
  };

  const isUserMangager = (auction) => {
    const currentUserAddress = window.ethereum?.selectedAddress?.toLowerCase();
    return  currentUserAddress == auction.manager.toLowerCase();
  }


  const getRowStyles = (hasWon, isOpen, isRefunded) => ({
    backgroundColor: hasWon ? "#90EE90" : isOpen ? "#BBDEFB" : isRefunded  ? "#FFD700" : "#E9E9F6",
    marginBottom: "1rem",
    "&:hover": {
      backgroundColor: hasWon ? "#77DD77" : isOpen ? "#A3CFFA" : isRefunded ? "#FFC107" : "#D0D0F0",
      cursor: "pointer",
    },
  });

  const getFontStyles = (auction, currentAddress, isOpen) => (
    {
    color : 
    isHighestBidder(auction, currentAddress) && isAuctionOpen(auction.endTime) ? "#11a811ff" :
    (isUserInAuction && isAuctionOpen(auction.endTime) && !isUserMangager(auction)) ? "#da0c0cff" :
    isOpen? 
    "#D07030D0"
     :
    "#0D0D4E"
  })

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

        {/* <Box textAlign="center" sx={{ margin: "1rem 0" }}>
          <Typography variant="h5" fontStyle={'italic'} fontFamily={'inherit'} >
            Your Remaining Budget: {remainingBudget === Infinity ? "Unlimited" : `${remainingBudget} wei`}
          </Typography>
        </Box> */}

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
                    "Address",  
                    "Data Description",
                    "Auction Status",
                    "Highest Bid",
                    "Number Of Bidders",
                    "Refund Status",
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
                  const refundStatus = userParticipated && !userWon && !auctionOpen
                    ? (auction.isRefunded ? "Refunded" : "Awaiting Refund")
                    : "N/A";
                  const currentAddress = window.ethereum?.selectedAddress?.toLowerCase();
                  // console.log("auction.isRefunded = ", auction.isRefunded);
                  // console.log("currentUserAddress =", auction.currentUserAddress);
                  // console.log("auction.manager =", auction.manager);
                  return (
                    <TableRow
                      key={index}
                      onClick={() => navigate(`/auction/${auction.address}`, { state: { remainingBudget } })}
                      sx={getRowStyles(userWon, auctionOpen, auction.isRefunded)}
                    >
                      <TableCell
                      sx={getFontStyles(auction, currentAddress)}
                      >{auction.address}</TableCell>
                      <TableCell
                      sx={getFontStyles(auction, currentAddress)}
                      align="center"
                      
                      >{auction.dataDescription}</TableCell>
                      <TableCell
                        align="center"
                    
                        sx={getFontStyles(auction, currentAddress, true)}
                        style={{fontWeight: "bold" }}
                      >
                        {getTimeLeft(auction.endTime)}
                      </TableCell>
                      <TableCell
                      align="center"
                      sx={getFontStyles(auction, currentAddress)}
                      >{auction.highestBid}</TableCell>
                      <TableCell
                      align="center"
                      sx={getFontStyles(auction, currentAddress)}
                      >{auction.approversCount}</TableCell>
                      <TableCell
                      sx={getFontStyles(auction, currentAddress)}
                      align="center">{refundStatus}</TableCell>
                      <TableCell align="center">
                        <Button
                          variant="contained"
                          style={{
                            backgroundColor: userWon ? "#2e7d32" : auction.isRefunded ? "#FFD700" : "#9090D0",
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
          </TableContainer>
        )}
      </div>
    </Layout>
  );
}

export default AuctionsListPage;