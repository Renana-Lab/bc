import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import { useMetaMask } from "../../Context/Context.js"; // Import useMetaMask hook
import Layout from "../../components/Layout.js";
import metamaskImg from "./Illustration_Metamask.png";
import styles from "./metamask.module.scss";
import { toast } from "react-hot-toast"; // Import hot-toast

function MetamaskTutorialPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isMetaMaskInstalled, checkIfConnected, requestConnection } = useMetaMask(); // Access context values
  const [, setNotConnected] = useState(true); // Default to true (assumes not connected)
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    checkIfConnected()
      .then((accounts) => {
        if (cancelled) return;
        setNotConnected(!accounts?.length);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isMetaMaskInstalled, checkIfConnected]);

  const handleContinue = async () => {
    setLoading(true);
    setConnectionError("");
    const result = await requestConnection();
    const accounts = Array.isArray(result) ? result : result?.accounts || [];
    const errorMessage = Array.isArray(result) ? "" : result?.error || "";
    const connected = Boolean(accounts?.length);
    setNotConnected(!connected);
    setLoading(false);

    if (connected) {
      const requestedRoute =
        typeof location.state?.from === "string" &&
        location.state.from.startsWith("/")
          ? location.state.from
          : "/auctions-list";
      navigate(requestedRoute, { replace: true });
    } else {
      const message =
        errorMessage ||
        "MetaMask did not return an account. Please unlock MetaMask, select an account, and try again.";
      setConnectionError(message);
      toast.error(message);
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
            alt="MetaMask wallet setup illustration"
          />

          <div className={styles.metamaskQuestion}>
            <h1 className={styles.metamaskTitle}>
              Are you logged in to MetaMask?
            </h1>
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
                  await handleContinue();
                }}
                disabled={loading}
              >
                {loading ? "Checking MetaMask..." : "Yes, I am connected"}
              </Button>
              <Button
                onClick={() => {
                  navigate("/metamask-guide");
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
                No, I don’t have a MetaMask account
              </Button>
            </div>
            {connectionError ? (
              <p className={styles.metamaskError}>{connectionError}</p>
            ) : null}
          </div>
        </span>
      </div>
    </Layout>
  );
}

export default MetamaskTutorialPage;
