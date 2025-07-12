import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "@mui/material/Button/index.js";
import { useMetaMask } from "../../Context/Context.js"; // Import useMetaMask hook
import Layout from "../../components/Layout.js";
import metamaskImg from "./Illustration_Metamask.png";
import styles from "./metamask.module.scss";
import { toast } from "react-hot-toast"; // Import hot-toast

function MetamaskTutorialPage() {
  const navigate = useNavigate();
  const { isMetaMaskInstalled, checkIfConnected } = useMetaMask(); // Access context values
  const [notConnected, setNotConnected] = useState(true); // Default to true (assumes not connected)
  const [loading, setLoading] = useState(true);

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
          </div>
        </span>
      </div>
    </Layout>
  );
}

export default MetamaskTutorialPage;
