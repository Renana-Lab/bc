import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import factory from "../../real_ethereum/factory";
import web3 from "../../real_ethereum/web3";
import styles from "./new.module.scss";
import {
  Button,
  CircularProgress,
  FormControl,
  TextField,
} from "@mui/material";
import { faQuestionCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import toast from "react-hot-toast";
import  "./new.module.scss";

function NewAuctionPage() {
  const [formData, setFormData] = useState({
    minimumContribution: "",
    auctionDuration: "",
    dataForSell: "",
    dataDescription: "",
  });
  const [explanation, setExplanation] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleTooltip = (field) => {
    setExplanation(explanation === field ? null : field);
  };

  const validateForm = () => {
    if (
      !formData.minimumContribution ||
      isNaN(formData.minimumContribution) ||
      Number(formData.minimumContribution) <= 0
    ) {
      toast.error("⚠️ Minimum contribution must be a positive number.");
      return false;
    }
    if (
      !formData.auctionDuration ||
      isNaN(formData.auctionDuration) ||
      formData.auctionDuration < 1 ||
      formData.auctionDuration > 30
    ) {
      toast.error("⚠️ Auction duration must be between 1 and 30 minutes.");
      return false;
    }
    if (!formData.dataForSell.trim()) {
      toast.error("⚠️ Data for sale cannot be empty.");
      return false;
    }
    if (!formData.dataDescription.trim()) {
      toast.error("⚠️ Data description cannot be empty.");
      return false;
    }
    return true;
  };

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (!validateForm()) return;

      setLoading(true);
      const toastId = toast.loading("⏳ Creating auction...");

      try {
        const accounts = await web3.eth.getAccounts();
        await factory.methods
          .createCampaign(
            formData.minimumContribution,
            formData.dataForSell,
            formData.dataDescription,
            formData.auctionDuration
          )
          .send({ from: accounts[0] });

        toast.success("🎉 Auction created successfully!", { id: toastId });
        navigate("/auctions-list");
      } catch (err) {
        console.error("Auction creation failed:", err);
        toast.error("❌ Auction creation failed. Please try again.", {
          id: toastId,
        });
      }
      setLoading(false);
    },
    [formData, navigate]
  );

  const renderTooltip = (field, text) => (
    <div className={styles.tooltip}>
      <label className={styles.tooltipLabel}>
        {text}
        <button
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
        {/* <img
            className={styles.Image}
            src="https://www.vancouverfringe.com/wp-content/uploads/2023/02/Silent-Auction-Blog.jpg"
            alt="Auction Preview"
          /> */}
        <FormControl
          style={{
            padding: "20px 0px 20px 120px",
            marginTop: "2rem",
            display: "flex",
            flexDirection: "column",
          }}
          className={styles.form}
          onSubmit={handleSubmit}
        >
          <h3 className={styles.introductionTitle}>Create Auction</h3>
          {renderTooltip("minBid", "Minimum Bid (in Wei)")}
          <TextField
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
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? <CircularProgress size={20} /> : "Create Auction"}
            </Button>
          </div>
        </FormControl>
      </div>

      <div style={{ textAlign: "center", marginTop: "2rem" }}>
        <Button
          variant="contained"
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
