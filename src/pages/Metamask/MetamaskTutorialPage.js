import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import { useMetaMask } from "../../Context/Context.js"; // Import useMetaMask hook
import Layout from "../../components/Layout";
import metamaskImg from "./metamask.jpg";
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
      toast.error("Hi! There might be a problem connecting your MetaMask account.");
    }
  };

  // useEffect(() => {

  //   navigate("/auctions-list");


  // }, [!isMetaMaskInstalled,!notConnected]);


  return (
    <Layout>
      <div className={styles.metamaskContainer}>
        
        <span style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent:"space-evenly", gap: "2.5rem"}}>


          <div className={styles.metamaskImage}>
            <img
              className={styles.metamaskimg}
              src={metamaskImg}
              height="230"
              width="345"
              alt="metamask"
            />
          </div>

          <div className={styles.metamaskQuestion}>
            <div className={styles.metamaskTitle}>Are you logged in to MetaMask?</div>
            <div className={styles.metamaskText}>
              Before buying/selling data, please make sure you are logged into a MetaMask account.
              <br />  
              If you don’t have a MetaMask account, please follow the tutorial to create one and come back.
            </div>
            <div className={styles.metamaskButtons}>
              <Button
                style={{
                  height: "2.5rem",
                  padding: "0.8rem",
                  borderRadius: "1rem",
                  backgroundColor: "#9090D0",
                  color: "white",
                  fontWeight: "600",
                  
                }}
                variant="outlined"
                onClick={async () => {
                  await checkIfConnected();
                  const updatedNotConnected = localStorage.getItem("notConnected");
                  setNotConnected(updatedNotConnected === "true");
                  handleContinue();
                }}
              >
                Yes, I am connected
              </Button>
              <Button
                style={{
                  height: "2.5rem",
                  padding: "0.8rem",
                  borderRadius: "1rem",
                  backgroundColor: "#9090D0",
                  color: "white",
                  fontWeight: "600",
                  
                }}
                variant="outlined"
              >
                <a
                  style={{ color: "white" }}
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


      {/* להכניס סרטון הדרכה */}
          {/* <div className="metamaskVideo">
            <iframe
              width="560"
              height="315"
              src="https://www.youtube.com/embed/2f1g0v3m8wE"
              title="YouTube video player"
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            ></iframe>
          </div> */}
      </div>
    </Layout>
  );
}

export default MetamaskTutorialPage;
