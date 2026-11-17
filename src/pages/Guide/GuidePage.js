import React from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Accordion, AccordionDetails, AccordionSummary, Button, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Layout from "../../components/Layout";
import { isInvisibleWalletMode } from "../../real_ethereum/wallets/walletMode.mjs";
import styles from "./guide.module.scss";

const STEPS = [
  {
    title: "Create or Sign In to Your Account",
    text: "Your account is created automatically the first time you open the platform.",
  },
  {
    title: "Check Your Starting Budget",
    text: "Every participant account receives a budget for bidding on data auctions. Your available budget is displayed in the top navigation bar at all times.",
  },
  {
    title: "Open an Auction",
    text: "Choose Start an Auction, add the data description and payload, set the minimum bid and duration (1–30 minutes, default 10), then submit it. Before the first bid, you may adjust only the minimum bid.",
    action: { label: "Start an Auction", to: "/open-auction" },
  },
  {
    title: "Participate in an Auction",
    text: "Open an active auction, review its description and minimum, and submit your total bid within your available budget. The highest bidder receives access to the dataset after the auction closes.",
    action: { label: "View Auctions", to: "/auctions-list" },
  },
];

// Platform guide (market parity, steps 1-4). Local mode only: there is no sign-in step to link to.
function GuidePage() {
  const navigate = useNavigate();
  if (!isInvisibleWalletMode()) return <Navigate to="/" replace />;

  return (
    <Layout>
      <div className={styles.page}>
        <div className={styles.hero}>
          <h1>Get Started with Your Marketplace Account</h1>
          <p className={styles.text}>
            Follow these simple steps to set up your account and start participating in our research data auctions.
          </p>
          <Button onClick={() => navigate("/")} startIcon={<ArrowBackIcon />}>
            Back to Home
          </Button>
        </div>
        {STEPS.map((step, index) => (
          <Accordion key={step.title} defaultExpanded={index === 0} slots={{ heading: "h2" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6" component="span" sx={{ fontWeight: 600, color: "#002884" }}>
                <span className={styles.step}>{index + 1}</span> {step.title}
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className={styles.text}>{step.text}</Typography>
              {step.action && (
                <Button variant="contained" className={styles.action} onClick={() => navigate(step.action.to)}>
                  {step.action.label}
                </Button>
              )}
            </AccordionDetails>
          </Accordion>
        ))}
      </div>
    </Layout>
  );
}

export default GuidePage;
