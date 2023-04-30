import React, { Component ,useState, useEffect } from "react";
// import Image from "next/image";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import factory from "./../../real_ethereum/factory";
import Layout from "../../components/Layout";
// import { Link } from "./../../routes";
import Countdown from "react-countdown";
import Campaign from "./../../real_ethereum/campaign";
import styles from "./auctions.module.scss";
import blockChainPicture from "./cryptoWallet.jpg";
import { Link, Navigate, useNavigate } from 'react-router-dom';


function AuctionsListPage () {
  const navigate = useNavigate();
  const [auctionsList, setAuctionsList] = useState([]);
  const fetchAuctionsList = async () => {
    let auctions = await factory.methods.getDeployedCampaigns().call();
    let auctionsList = [];
    for (let i = 0; i < auctions.length; i++) {
      let auction = await Campaign(auctions[i]);
      let auctionDetails = await auction.methods.getSummary().call();
      let contributors = await auction.methods.getAddresses().call();
      auctionsList.push({
        address: auctions[i],
        contributors: contributors,
        dataForSell: auctionDetails[5],
        endTime: Number(auctionDetails[7] + "000"),
        highestBidder: auctionDetails[8],
        timeLeft: Number(auctionDetails[7] + "000") < Date.now(),
        dataDescription: auctionDetails[6],
        highestBid: auctionDetails[4],
      });
    }
    setAuctionsList(auctionsList);
  };
  useEffect(() => {
    fetchAuctionsList();
  }, []);
  const getTimeLeft = (endTime) => {
    if (Number(endTime) < Date.now()) {
      return <div>Closed</div>;
    } else {
      return (
        <div>
          <Countdown date={endTime} /> minutes left
        </div>
      );
    }
  };
  if (auctionsList) {
    const items = auctionsList.reverse().map((auction) => {
      let contributorsCount;
      if (auction.contributors) {
        contributorsCount = auction.contributors.length;
      } else {
        contributorsCount = 0;
      }
      return {
        address: auction.address,
        dataDescription: auction.dataDescription,
        highestBid: auction.highestBid,
        timeLeft: <div>{getTimeLeft(auction.endTime)}</div>,
        contributorsCount: contributorsCount,
      };
    });
    return (
      <Layout>
       <div className={styles.page}>
                <div className={styles.createAuction}>

                   <div className={styles.introduction}>
                   <div className={styles.introductionText}>
                     <p className={styles.introductionTitle}>
                      Welcome to the Blockchain Data Market Platform
                     </p>
      
                   <p>Scroll down to see all the open and closed auctions.</p>
                     <p>
                         Do you want to put your data for auction?
                          <Button
                              variant="outlined"
                              style={{
                                marginLeft: "1rem",
                                height: "2.5rem",
                                padding: "0.8rem",
                                borderRadius: "1rem",
                                backgroundColor: "#002884",
                                color: "#D8DCF0",
                                fontWeight: "500",
                              }}
                            >
                              <a
                                style={{
                                  color: "#D8DCF0",
                                }}
                              >
                                Start an auction
                              </a>
                            </Button>
                          {/* </Link> */}
                        </p>
                      </div>
                    </div>
                  </div>
                  <TableContainer component={Paper}>
                    <Table sx={{ minWidth: 650 }} aria-label="simple table">
                      <TableHead>
                        <TableRow>
                          <TableCell className={styles.headerCell}>Address</TableCell>
                          <TableCell className={styles.headerCell} align="center">
                            Data Description
                          </TableCell>
                          <TableCell className={styles.headerCell} align="center">
                            Auction Status
                          </TableCell>
                          <TableCell className={styles.headerCell} align="center">
                            Highest Bid
                          </TableCell>
                          <TableCell className={styles.headerCell} align="center">
                            Number Of Bidders
                          </TableCell>
                          <TableCell align="right"></TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {items.map((row, index) => (
                          <TableRow
                            className={index % 2 === 0 ? "even" : "odd"}
                            key={index}
                            sx={{ "&:last-child td, &:last-child th": { border: 0 } }}
                          >
                            <TableCell component="th" scope="row">
                              {row.address}
                            </TableCell>
                            <TableCell align="center">
                              {row.dataDescription}
                            </TableCell>
                            <TableCell align="center">{row.timeLeft}</TableCell>
                            <TableCell align="center">{row.highestBid}</TableCell>
                            <TableCell align="center">
                              {row.contributorsCount}
                            </TableCell>
                            <TableCell align="center">
                              {" "}
                              <div className={styles.description}>
                                {/* <Link route={`/auction/${row.address}`}> */}
                                  <Button
                                    style={{
                                      height: "2.5rem",
                                      padding: "0.8rem",
                                      borderRadius: "1rem",
                                      backgroundColor: "#D8DCF0",
                                      color: "#002884",
                                      fontWeight: "600",
                                    }}
                                    variant="outlined"
                                    onClick={() => {
                                      navigate('/auction/${row.address}')// this.props.navigate("/metamask-tutorial");
                                      // <Link to="/metamask-tutorial"/>
                                    }}
                                  >
                                    <a
                                      style={{
                                        color: "#002884",
                                      }}
                                    >
                                      View Auction
                                    </a>
                                  </Button>
                                {/* </Link> */}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </div>
              </Layout>
    )


}
}
export default AuctionsListPage;
