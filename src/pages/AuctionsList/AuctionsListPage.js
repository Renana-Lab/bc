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
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import Countdown from "react-countdown";
import factory from "../../real_ethereum/factory";
import Campaign from "../../real_ethereum/campaign";
import web3 from "../../real_ethereum/web3";
import Layout from "../../components/Layout";
import styles from "./auctions.module.scss";
import picSrc from "./Illustration_Start.png";

function AuctionsListPage() {


  const navigate = useNavigate();
  const [auctionsList, setAuctionsList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!window.ethereum) {
      navigate("/"); // Redirect away if no MetaMask
      return;
    }
  }, );

  useEffect(() => {
    const fetchNetworkId = async () => {
      try {
        const id = await web3.eth.net.getId();
        console.log("✅ Connected Network ID:", id);
      } catch (error) {
        console.error("❌ Error fetching network ID:", error);
      }
    };
    fetchNetworkId();
  }, );

  useEffect(() => {
    const fetchAuctionsList = async () => {
      try {
        const auctions = await factory.methods.getDeployedCampaigns().call();
        const auctionData = await Promise.all(
          auctions.map(async (address) => {
            const auction = Campaign(address);
            const details = await auction.methods.getSummary().call();
            const contributors = await auction.methods.getAddresses().call();
            return {
              address,
              contributorsCount: contributors.length || 0,
              dataForSell: details[5],
              endTime: Number(details[7] + "000"),
              highestBidder: details[8],
              timeLeft: Number(details[7] + "000") < Date.now(),
              dataDescription: details[6],
              highestBid: details[4],
            };
          })
        );
        setAuctionsList(auctionData);
      } catch (error) {
        console.error("❌ Error fetching auctions:", error);
      } finally {
        setLoading(false); // Stop loading
      }
    };

    fetchAuctionsList();
  }, []);

  const getTimeLeft = (endTime) => {
    return Number(endTime) < Date.now() ? (
      <div>Closed</div>
    ) : (
      <Countdown date={endTime} />
    );
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
            <CircularProgress size={50} /> {/* Loading spinner */}
            <p>Loading auctions...</p>
          </div>
        ) : (
          <TableContainer
            component={Paper}
            style={{
              margin: "0 auto",
              padding: "30px",
              borderRadius: "20px",
              width: "max-content",
            }}
          >
            <Table aria-label="auctions table">
              <TableHead>
                <TableRow>
                  <TableCell style={{ color: "#101070", fontWeight: "bold" }}>
                    Address
                  </TableCell>
                  <TableCell
                    align="center"
                    style={{ color: "#101070", fontWeight: "bold" }}
                  >
                    Data Description
                  </TableCell>
                  <TableCell
                    align="center"
                    style={{ color: "#101070", fontWeight: "bold" }}
                  >
                    Auction Status
                  </TableCell>
                  <TableCell
                    align="center"
                    style={{ color: "#101070", fontWeight: "bold" }}
                  >
                    Highest Bid
                  </TableCell>
                  <TableCell
                    align="center"
                    style={{ color: "#101070", fontWeight: "bold" }}
                  >
                    Number Of Bidders
                  </TableCell>
                  <TableCell align="right"></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {auctionsList
                  .slice()
                  .reverse()
                  .map((auction, index) => (
                    <TableRow
                      key={index}
                      onClick={() => navigate(`/auction/${auction.address}`)}
                      sx={{
                        backgroundColor: "#E9E9F6",
                        marginBottom: "4rem",
                        "&:hover": {
                          backgroundColor: "#D0D0F0", // 👈 Change this to whatever hover color you want
                          cursor: "pointer", // Optional: make it feel interactive
                        },
                      }}
                    >
                      <TableCell>{auction.address}</TableCell>
                      <TableCell align="center">
                        {auction.dataDescription}
                      </TableCell>
                      <TableCell
                        align="center"
                        style={{ color: "#D07030D0", fontWeight: "bold" }}
                      >
                        {getTimeLeft(auction.endTime)}
                      </TableCell>
                      <TableCell align="center">{auction.highestBid}</TableCell>
                      <TableCell align="center">
                        {auction.contributorsCount}
                      </TableCell>
                      <TableCell align="center">
                        <Button
                          variant="contained"
                          style={{
                            backgroundColor: "#9090D0",
                            color: "white",
                            borderRadius: "20px",
                            padding: "10px 20px",
                          }}
                          onClick={() =>
                            navigate(`/auction/${auction.address}`)
                          }
                        >
                          View Auction
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </div>
    </Layout>
  );
}

export default AuctionsListPage;
