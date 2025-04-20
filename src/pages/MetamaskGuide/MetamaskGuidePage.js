import React from "react";
import Layout from "../../components/Layout";
import styles from "./metamask.module.scss";
import vidSrc from "./vid.mp4";
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  Button
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useNavigate } from "react-router-dom";

const MetamaskGuidePage = () => {
  const navigate = useNavigate();

  return (
    <Layout>
      <h1 style={{ textAlign: "center", marginTop: "2rem" }}>
        How to set up your MetaMask wallet and add Ethereum to it
      </h1>
      <div className={styles.metamaskVideo}>
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="h6">Step 1: Download the MetaMask extension</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Button
              href="https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn"
              target="_blank"
              rel="noopener noreferrer"
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
              After installing the extension, click the MetaMask icon and follow instructions.
            </Typography>
          </AccordionDetails>
        </Accordion>

        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="h6">Step 3: Add currency to your wallet</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography>
              Add Ethereum to your wallet via faucet (once every 24h):
            </Typography>
            <br />
            <Button
              href="https://cloud.google.com/application/web3/u/2/faucet/ethereum/sepolia"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                backgroundColor: "#9090D0",
                color: "white",
                borderRadius: "20px",
                textTransform: "none"
              }}
              variant="contained"
            >
              Go to the Ethereum Sepolia Faucet
            </Button>
            <br /><br />
            <video width="940" height="515" controls muted>
              <source src={vidSrc} type="video/mp4" />
            </video>
            <br />
            <hr />
            <br />
            <Button
              onClick={() => navigate("/auctions-list")}
              sx={{
                height: "2.5rem",
                padding: "0.8rem",
                borderRadius: "30px",
                backgroundColor: "#9090D0",
                color: "white",
                fontWeight: "600",
              }}
              variant="contained"
            >
              Finally, I am connected
            </Button>
          </AccordionDetails>
        </Accordion>
      </div>
    </Layout>
  );
};

export default MetamaskGuidePage;
