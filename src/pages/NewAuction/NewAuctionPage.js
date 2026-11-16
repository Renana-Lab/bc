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
import { getCreatedAuctionAddress, registerCreatedAuctionReceipt } from "../../real_ethereum/activeAuctionRegistry";
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
import { useAdminAccess } from "../ManageBudget/useAdminAccess";
import {
  DEFAULT_DURATION,
  DESCRIPTION_MAX_CHARS,
  DURATION_MAX,
  MIN_BID_MAX,
  PAYLOAD_MAX_BYTES,
  utf8ByteLength,
  validateAuctionForm,
} from "./auctionLimits";
import { getWalletCopy } from "../../real_ethereum/wallets/walletCopy";
import { participantMessage } from "../../real_ethereum/wallets/participantCopy";
import "./new.module.scss";

const requestConnectedAccount = async () => {
  let accounts = await requestEthereumAccounts();
  if (!accounts?.length) {
    accounts = await web3.eth.getAccounts();
  }
  const account = accounts?.[0];

  if (!account) {
    throw new Error(participantMessage("No wallet account is connected."));
  }

  return account;
};

const getTransactionErrorMessage = (err) => {
  const message = JSON.stringify(err?.message || err || "");

  if (message.includes("replacement transaction underpriced")) {
    return getWalletCopy().txPending;
  }
  if (
    message.includes("User denied") ||
    message.includes("User rejected") ||
    message.includes("4001")
  ) {
    return getWalletCopy().txRejected;
  }
  return "Transaction failed. Please try again.";
};

function NewAuctionPage() {
  const [formData, setFormData] = useState({
    dataDescription: "",
    dataForSell: "",
    minimumContribution: "",
    auctionDuration: DEFAULT_DURATION,
  });
  const [errors, setErrors] = useState({});
  // The factory-address panel is an operator detail: admins only (UI gate).
  const { isAdmin } = useAdminAccess();
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
        navigate("/"); // Redirect away if no wallet is available
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
    setErrors((prev) => (prev[name] ? { ...prev, [name]: "" } : prev));
  };

  const handleTooltip = (field) => {
    setExplanation(explanation === field ? null : field);
  };

  const validateForm = useCallback(() => {
    const found = validateAuctionForm(formData);
    setErrors(found);
    return Object.keys(found).length === 0;
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
        const receipt = await factory.methods
          .createCampaign(
            formData.minimumContribution,
            formData.dataForSell,
            formData.dataDescription.trim(),
            formData.auctionDuration
          )
          .send({ from: account });

        registerCreatedAuctionReceipt(
          activeMarket.address,
          receipt,
          {
            minimumContribution: formData.minimumContribution,
            manager: account,
            endTimeSec:
              Math.floor(Date.now() / 1000) +
              Number(formData.auctionDuration) * 60,
          },
          "single-auction-created",
        );

        toast.success("🎉 Auction created successfully!", { id: toastId });
        const createdAddress = getCreatedAuctionAddress(receipt);
        navigate(createdAddress ? `/auction/${createdAddress}` : "/auctions-list");
      } catch (err) {
        console.error("Auction creation failed:", err);
        toast.error(getTransactionErrorMessage(err), { id: toastId });
      } finally {
        submittingRef.current = false;
        setLoading(false);
      }
    },
    [activeMarket.address, formData, navigate, validateForm]
  );

  const renderTooltip = (field, text, help = text) => (
    <div className={styles.tooltip}>
      <label className={styles.tooltipLabel}>
        {text}
        <button
          type="button"
          onClick={() => handleTooltip(field)}
          className={styles.circleIcon}
          aria-label={`Info about ${text}`}
          aria-expanded={explanation === field}
        >
          <FontAwesomeIcon icon={faQuestionCircle} />
        </button>
      </label>
      {explanation === field && (
        <div className={styles.description}>{help}</div>
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
          {isAdmin && (
          <Box
            sx={{
              width: "85%",
              px: 1.25,
              py: 1,
              border: "1px solid rgba(16, 48, 144, 0.12)",
              borderRadius: 1.5,
              backgroundColor: "rgba(248, 250, 255, 0.58)",
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 700, color: "#002884" }}>
              Auction destination
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.15 }}
            >
              This auction will be opened in this branch's factory contract.
            </Typography>
            <Box
              component="span"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                mt: 0.75,
                px: 1,
                py: 0.25,
                border: "1px solid rgba(16, 48, 144, 0.14)",
                borderRadius: 999,
                backgroundColor: "rgba(255, 255, 255, 0.55)",
                color: "#0d0d4e",
                fontSize: "0.82rem",
                fontWeight: 600,
                lineHeight: 1.35,
              }}
            >
              {activeMarket.environmentLabel || activeMarket.label}
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.55, overflowWrap: "anywhere", opacity: 0.76 }}
            >
              {activeMarket.address || "No factory address configured"}
            </Typography>
          </Box>
          )}
          {renderTooltip(
            "dataDescription",
            "Description of the Data",
            "Describe the information in words (e.g., my shoe size); a number alone is not allowed. This description will be visible to all buyers and cannot be changed after you create the auction.",
          )}
          <TextField
            sx={{ width: "85%" }}
            name="dataDescription"
            required
            value={formData.dataDescription}
            onChange={handleChange}
            error={Boolean(errors.dataDescription)}
            helperText={errors.dataDescription || undefined}
            inputProps={{ maxLength: DESCRIPTION_MAX_CHARS, "aria-label": "Description of the Data" }}
          />

          {renderTooltip(
            "dataForSale",
            "Data For Sell",
            "Enter the actual information you are selling (e.g., your shoe size). Only the winning buyer will receive this information after the auction ends. You cannot change it after creating the auction.",
          )}
          <TextField
            sx={{ width: "85%" }}
            name="dataForSell"
            required
            value={formData.dataForSell}
            onChange={handleChange}
            error={Boolean(errors.dataForSell)}
            helperText={
              errors.dataForSell ||
              `${utf8ByteLength(formData.dataForSell)} / ${PAYLOAD_MAX_BYTES} bytes`
            }
            inputProps={{ maxLength: PAYLOAD_MAX_BYTES, "aria-label": "Data for sale" }}
          />

          {renderTooltip(
            "minBid",
            "Minimum Bid",
            "The lowest price you are willing to accept for selling your information (in wei).",
          )}
          <TextField
            type="number"
            sx={{ width: "85%" }}
            name="minimumContribution"
            required
            value={formData.minimumContribution}
            onChange={handleChange}
            error={Boolean(errors.minimumContribution)}
            helperText={errors.minimumContribution || undefined}
            inputProps={{ min: 1, max: MIN_BID_MAX, "aria-label": "Minimum Bid" }}
          />

          {renderTooltip(
            "auctionTime",
            "Auction Duration (1–30 minutes)",
            "Enter how many minutes your auction will last. Bidding starts when you create the auction. You cannot change the duration afterward.",
          )}
          <TextField
            sx={{ width: "85%" }}
            type="number"
            name="auctionDuration"
            required
            value={formData.auctionDuration}
            onChange={handleChange}
            error={Boolean(errors.auctionDuration)}
            helperText={errors.auctionDuration || undefined}
            inputProps={{ min: 1, max: DURATION_MAX, "aria-label": "Auction Duration (1–30 minutes)" }}
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
                fontWeight: 700,
              }}
              type="submit"
              variant="contained"
              aria-label="Create auction"
              disabled={loading}
            >
              {loading ? <CircularProgress size={20} /> : "CREATE AUCTION"}
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
          RETURN TO AUCTIONS MAIN SCREEN
        </Button>
      </div>
    </Layout>
  );
}

export default NewAuctionPage;
