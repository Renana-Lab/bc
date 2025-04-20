import React from "react";
import Layout from "../../components/Layout";
import styles from "./metamask.module.scss";
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  Button,
  Tooltip,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { useNavigate } from "react-router-dom";

const MetamaskGuidePage = () => {
  const navigate = useNavigate();

  return (
    <Layout>
      <div className={styles.metamaskContainer}>
        {/* Hero Section */}
        <div className={styles.hero}>
          <h1 className={styles.metamaskTitle}>
            Get Started with Your MetaMask Wallet and Ethereum
          </h1>
          <p className={styles.metamaskText}>
            Follow these simple steps to set up your MetaMask wallet and start
            participating in our blockchain auctions.
          </p>
          <Button
            className={styles.backButton}
            onClick={() => navigate("/")}
            startIcon={<ArrowBackIcon />}
          >
            Back to Home
          </Button>
        </div>

        {/* Steps Section */}
        <div className={styles.metamaskVideo}>
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6">
                <span className={styles.stepNumber}>1</span> Download the
                MetaMask Extension
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className={styles.metamaskText}>
                Install MetaMask to manage your Ethereum wallet directly in your
                browser.
              </Typography>
              <Tooltip title="Opens the Chrome Web Store in a new tab">
                <Button
                  href="https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.actionButton}
                >
                  Download MetaMask Extension
                </Button>
              </Tooltip>
            </AccordionDetails>
          </Accordion>

          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6">
                <span className={styles.stepNumber}>2</span> Set Up Your
                MetaMask Wallet
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className={styles.metamaskText}>
                After installing, click the MetaMask icon in your browser
                toolbar. Follow the prompts to create a new wallet, set a
                password, and save your secret recovery phrase securely.
              </Typography>
            </AccordionDetails>
          </Accordion>

          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6">
                <span className={styles.stepNumber}>3</span> Add Ethereum to
                Your Wallet
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography className={styles.metamaskText}>
                Add Ethereum to your wallet using a testnet faucet (available
                once every 24 hours). Watch the video below for guidance.
              </Typography>
              <Tooltip title="Opens the Sepolia Faucet in a new tab">
                <Button
                  href="https://cloud.google.com/application/web3/u/2/faucet/ethereum/sepolia"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.actionButton}
                >
                  Get Free Ethereum from Sepolia Faucet
                </Button>
              </Tooltip>
              <video className={styles.video} controls muted>
                <source
                  src={
                    "https://bc-hostfiles.s3.us-east-2.amazonaws.com/vid.mp4"
                  }
                  type="video/mp4"
                />
                Your browser does not support the video tag.
              </video>
              <Tooltip title="View available auctions">
                <Button
                  onClick={() => navigate("/auctions-list")}
                  className={styles.actionButton}
                >
                  Go to Auctions
                </Button>
              </Tooltip>
            </AccordionDetails>
          </Accordion>
        </div>

        {/* Footer Section */}
        <div className={styles.footer}>
          <Typography className={styles.metamaskText}>
            Need more help? Visit the MetaMask tutorial page.
          </Typography>
          <Button
            href="https://support.metamask.io/start/getting-started-with-metamask/"
            className={styles.actionButton}
          >
            Visit MetaMask Tutorial
          </Button>
        </div>
      </div>
    </Layout>
  );
};

export default MetamaskGuidePage;
