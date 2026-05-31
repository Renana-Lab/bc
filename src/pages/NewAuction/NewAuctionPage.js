/* eslint-env es2020 */
import React, { useCallback, useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import factory from "../../real_ethereum/factory";
import web3 from "../../real_ethereum/web3";
import {
  requestEthereumAccounts,
  waitForEthereumProvider,
} from "../../real_ethereum/ethereumProvider";
import {
  getActiveMarket,
  getMarketOptions,
  subscribeToMarketChanges,
} from "../../real_ethereum/marketConfig";
import styles from "./new.module.scss";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  TextField,
  Typography,
} from "@mui/material";
import { faQuestionCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import toast from "react-hot-toast";
import picSrc from "./Illustration_Create.png";
import "./new.module.scss";

const isWholeNumber = (value) => /^\d+$/.test(String(value || ""));
const isPositiveWholeNumber = (value) =>
  isWholeNumber(value) && BigInt(value) > 0n;

const getAuctionValidationError = (auction, label = "Auction") => {
  if (!isPositiveWholeNumber(auction.minimumContribution)) {
    return `${label}: minimum bid must be a positive whole number.`;
  }

  if (
    !isWholeNumber(auction.auctionDuration) ||
    Number(auction.auctionDuration) < 1 ||
    Number(auction.auctionDuration) > 30
  ) {
    return `${label}: duration must be a whole number between 1 and 30.`;
  }

  if (!auction.dataForSell.trim()) {
    return `${label}: data for sale cannot be empty.`;
  }

  if (!auction.dataDescription.trim()) {
    return `${label}: description cannot be empty.`;
  }

  return "";
};

const validateAuctionInput = (auction, label = "Auction") => {
  const error = getAuctionValidationError(auction, label);
  if (error) {
    toast.error(error);
    return false;
  }
  return true;
};

const requestConnectedAccount = async () => {
  let accounts = await requestEthereumAccounts();
  if (!accounts?.length) {
    accounts = await web3.eth.getAccounts();
  }
  const account = accounts?.[0];

  if (!account) {
    throw new Error("No wallet account is connected.");
  }

  return account;
};

const getTransactionErrorMessage = (err) => {
  const message = JSON.stringify(err?.message || err || "");

  if (message.includes("replacement transaction underpriced")) {
    return "MetaMask has a pending transaction. Wait for it, or speed/cancel it in Activity.";
  }
  if (
    message.includes("User denied") ||
    message.includes("User rejected") ||
    message.includes("4001")
  ) {
    return "Transaction rejected in MetaMask.";
  }
  return "Transaction failed. Please try again.";
};

function NewAuctionPage() {
  const [formData, setFormData] = useState({
    minimumContribution: "",
    auctionDuration: "",
    dataForSell: "",
    dataDescription: "",
  });
  const [explanation, setExplanation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeMarket, setActiveMarketState] = useState(getActiveMarket());
  const [, setMarketOptions] = useState(getMarketOptions());
  const submittingRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    waitForEthereumProvider().then((provider) => {
      if (!cancelled && !provider) {
        navigate("/"); // Redirect away if no MetaMask
      }
    });

    return () => {
      cancelled = true;
    };

  }, [navigate]);

  useEffect(() => {
    return subscribeToMarketChanges((market) => {
      setActiveMarketState(market);
      setMarketOptions(getMarketOptions());
    });
  }, []);

  const handleChange = (event) => {
    const { name, value } = event.target;

    // For numeric fields, allow only positive integers
    if (name === "minimumContribution" || name === "auctionDuration") {
      if (!/^\d*$/.test(value)) return; // Reject non-digit input
    }

    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleTooltip = (field) => {
    setExplanation(explanation === field ? null : field);
  };

  const validateForm = useCallback(() => {
    return validateAuctionInput(formData, "Auction");
  }, [formData]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (submittingRef.current) return;
      if (!validateForm()) return;

      submittingRef.current = true;
      setLoading(true);
      const toastId = toast.loading("⏳ Creating auction...");

      try {
        const account = await requestConnectedAccount();
        await factory.methods
          .createCampaign(
            formData.minimumContribution,
            formData.dataForSell,
            formData.dataDescription,
            formData.auctionDuration
          )
          .send({ from: account });

        toast.success("🎉 Auction created successfully!", { id: toastId });
        navigate("/auctions-list");
      } catch (err) {
        console.error("Auction creation failed:", err);
        toast.error(getTransactionErrorMessage(err), { id: toastId });
      } finally {
        submittingRef.current = false;
        setLoading(false);
      }
    },
    [formData, navigate, validateForm]
  );

  const renderTooltip = (field, text) => (
    <div className={styles.tooltip}>
      <label className={styles.tooltipLabel}>
        {text}
        <button
          type="button"
          onClick={() => handleTooltip(field)}
          className={styles.circleIcon}
        >
          <FontAwesomeIcon icon={faQuestionCircle} />
        </button>
      </label>
      {explanation === field && (
        <div className={styles.description}>{text}</div>
      )}
    </div>
  );

  return (
    <Layout>
      <div className={styles.direction}>
        <img
          className={styles.Image}
          src={picSrc}
          alt="Create a blockchain data auction"
        />
        <FormControl
          component="form"
          style={{
            padding: "20px 0px 20px 220px",
            marginTop: "2rem",
            display: "flex",
            flexDirection: "column",
          }}
          className={styles.form}
          onSubmit={handleSubmit}
        >
          <h1 className={styles.introductionTitle}>Create Auction</h1>
          <Box
            sx={{
              width: "85%",
              p: 1.5,
              border: "1px solid #d9dff2",
              borderRadius: 2,
              backgroundColor: "#f8faff",
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 800, color: "#002884" }}>
              Auction destination
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.25, mb: 1 }}
            >
              This auction will be opened in this branch's factory contract.
            </Typography>
            <TextField
              size="small"
              label="Environment"
              value={activeMarket.environmentLabel || activeMarket.label}
              fullWidth
              InputProps={{ readOnly: true }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.75, overflowWrap: "anywhere" }}
            >
              {activeMarket.address || "No factory address configured"}
            </Typography>
          </Box>
          {renderTooltip("minBid", "Minimum Bid (in Wei)")}
          <TextField
            type="number"
            sx={{ width: "85%" }}
            name="minimumContribution"
            value={formData.minimumContribution}
            onChange={handleChange}
          />

          {renderTooltip("dataDescription", "Description of the Data")}
          <TextField
            sx={{ width: "85%" }}
            name="dataDescription"
            value={formData.dataDescription}
            onChange={handleChange}
          />

          {renderTooltip("dataForSale", "Data For Sale")}
          <TextField
            sx={{ width: "85%" }}
            name="dataForSell"
            value={formData.dataForSell}
            onChange={handleChange}
          />

          {renderTooltip("auctionTime", "Auction Duration (1-30 mins)")}
          <TextField
            sx={{ width: "85%" }}
            type="number"
            name="auctionDuration"
            min="1"
            max="30"
            value={formData.auctionDuration}
            onChange={handleChange}
          />

          <div
            style={{
              width: "85%",
              display: "flex",
              justifyContent: "flex-end",
              marginTop: "2rem",
            }}
          >
            <Button
              style={{
                backgroundColor: "#9090D0",
                color: "white",
                borderRadius: "20px",
                padding: "10px 20px",
                width: "300px",
              }}
              type="submit"
              variant="contained"
              disabled={loading}
            >
              {loading ? <CircularProgress size={20} /> : "Create Auction"}
            </Button>
          </div>
        </FormControl>
      </div>

      <div
        style={{
          textAlign: "center",
          marginTop: "2rem",
          paddingBottom: "2rem",
        }}
      >
        <Button
          variant="contained"
          className={styles.returnButton}
          style={{
            backgroundColor: "#103090",
            color: "white",
            borderRadius: "20px",
            padding: "10px 20px",
            width: "650px",
          }}
          onClick={() => navigate("/auctions-list")}
        >
          Return To Auctions Main Screen
        </Button>
      </div>
    </Layout>
  );
}

export default NewAuctionPage;
