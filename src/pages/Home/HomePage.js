import React from "react";
import styles from "./home.module.scss";
import Layout from "../../components/Layout";
import Button from "@mui/material/Button";
import { useNavigate } from "react-router-dom";
import Welcomepic from "./Illustration_Wel.png";
function HomePage() {
  const navigate = useNavigate();
  return (
    <Layout>
      <div className={styles.container}>
        <div className={styles.contentContainer}>
          <div className={styles.welcomeSection}>
            <img
              className={styles.metamaskimg}
              src={Welcomepic}
              height="330"
              width="400"
              alt="Blockchain data marketplace illustration"
            />
            <div className={styles.introText}>
              <h1 style={{ margin: "0", lineHeight: 1.08 }}>
                Welcome to our data marketplace
              </h1>
              <br />
              <p style={{ margin: "0", fontSize: "1.2rem" }}>
                This is a blockchain based research platform, for running <br />
                auctions of personal data using cryptocurrency.
                <br />
                Each auction lasts up to 30 mins.
              </p>
            </div>
          </div>
        </div>
        <div className={styles.buttonsContainer}>
          <Button
            className={styles.primaryButton}
            variant="contained"
            onClick={() => {
              navigate("metamask-login");
            }}
          >
            Continue
          </Button>
          <Button className={styles.secondaryButton} variant="outlined">
            <a
              style={{
                color: "#002884",
              }}
              href="https://www.mturk.com/"
            >
              No Thanks
            </a>
          </Button>
        </div>
      </div>
    </Layout>
  );
}
export default HomePage;
