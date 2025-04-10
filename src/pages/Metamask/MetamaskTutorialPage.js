import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import { useMetaMask } from "../../Context/Context.js"; // Import useMetaMask hook
import Layout from "../../components/Layout";
import metamaskImg from "./Illustration_Metamask.png";
import styles from "./metamask.module.scss";
import vidSrc from "./vid.mp4";
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

import { toast } from "react-hot-toast"; // Import hot-toast

function MetamaskTutorialPage() {
  const navigate = useNavigate();
  const { isMetaMaskInstalled, checkIfConnected } = useMetaMask(); // Access context values
  const [notConnected, setNotConnected] = useState(true); // Default to true (assumes not connected)
  const [loading, setLoading] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    const storedNotConnected = localStorage.getItem("notConnected");
    if (storedNotConnected !== null) {
      setNotConnected(storedNotConnected === "true");
      setLoading(false);
    } else {
      checkIfConnected().then(() => {
        const updatedNotConnected = localStorage.getItem("notConnected");
        setNotConnected(updatedNotConnected === "true");
        setLoading(false);
      });
    }
  }, [isMetaMaskInstalled, checkIfConnected]);

  const handleContinue = () => {
    if (!loading && !notConnected && isMetaMaskInstalled) {
      navigate("/auctions-list");
    } else {
      toast.error(
        "Hi! There might be a problem connecting your MetaMask account."
      );
    }
  };

  return (
    <Layout>
      <div className={styles.metamaskContainer}>
        <span
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: "2.5rem",
          }}
        >
          <img
            className={styles.metamaskimg}
            src={metamaskImg}
            height="250px"
            width="200px"
            alt="metamask"
          />

          <div className={styles.metamaskQuestion}>
            <div className={styles.metamaskTitle}>
              Are you logged in to MetaMask?
            </div>
            <div className={styles.metamaskText}>
              Before starting buying/selling data, please make sure you are
              logged into a Metamask account.
              <br />
              If you don’t have a Metamask account, please follow the Metamask
              tutorial to create one and come back to start using our Blockchain
              data market.
            </div>
            <div className={styles.metamaskButtons}>
              <Button
                style={{
                  height: "2.5rem",
                  padding: "0.8rem",
                  borderRadius: "30px",
                  backgroundColor: "#9090D0",
                  color: "white",
                  fontWeight: "600",
                }}
                variant="contained"
                onClick={async () => {
                  await checkIfConnected();
                  const updatedNotConnected =
                    localStorage.getItem("notConnected");
                  setNotConnected(updatedNotConnected === "true");
                  handleContinue();
                }}
              >
                Yes, I am connected
              </Button>
              <Button
                onClick={() => {
                  setShowGuide(true);
                }}
                style={{
                  height: "2.5rem",
                  padding: "0.8rem",
                  borderRadius: "30px",
                  backgroundColor: "#9090D0",
                  color: "white",
                  fontWeight: "600",
                }}
                variant="contained"
              >
                <a
                  style={{ color: "white", textDecoration: "none" }}
                  href="https://support.metamask.io/start/getting-started-with-metamask/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  No, I don’t have a MetaMask account
                </a>
              </Button>
            </div>
          </div>
        </span>

        {showGuide && (
  <div className={styles.metamaskVideo}>
    <Accordion >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="h6">Step 1: Download the MetaMask extension</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Button
        rel="noopener noreferrer"
          href="https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn"
          sx={{
            backgroundColor: "#9090D0",
            color: "white",
            borderRadius: "20px",
            textTransform: "none"
          }}
          variant="contained"
        >
          Download from Chrome Web Store
        </Button>
      </AccordionDetails>
    </Accordion>

    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="h6">Step 2: Connect your Google account to MetaMask</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography>
          Follow the instructions on MetaMask to connect your Google account after installing the extension.
        </Typography>
      </AccordionDetails>
    </Accordion>

    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="h6">Step 3: Add currency to your wallet</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography paragraph>
          After downloading the MetaMask extension from the web store:
        </Typography>
        <video width="940" height="515" controls muted>
          <source src={vidSrc} type="video/mp4" />
        </video>
      </AccordionDetails>
    </Accordion>
  </div>
)}
      </div>
    </Layout>
  );
}

export default MetamaskTutorialPage;
