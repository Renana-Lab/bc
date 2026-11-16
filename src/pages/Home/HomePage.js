import React from "react";
import styles from "./home.module.scss";
import Layout from "../../components/Layout";
import Button from "@mui/material/Button";
import { useNavigate } from "react-router-dom";
import { getWalletCopy } from "../../real_ethereum/wallets/walletCopy";
import { participantText } from "../../real_ethereum/wallets/participantCopy";
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
              alt={participantText("homeImageAlt")}
            />
            <div className={styles.introText}>
              <h1 style={{ margin: "0", lineHeight: 1.08 }}>
                Welcome to our data marketplace
              </h1>
              <br />
              <p style={{ margin: "0", fontSize: "1.2rem" }}>
                {participantText("homeBody").split("\n").map((line, index) => (
                  <React.Fragment key={line}>
                    {index > 0 && <br />}
                    {line}
                  </React.Fragment>
                ))}
              </p>
            </div>
          </div>
        </div>
        <div className={styles.buttonsContainer}>
          <Button
            className={styles.primaryButton}
            variant="contained"
            onClick={() => {
              navigate(getWalletCopy().loginPath.replace(/^\//, ""));
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    </Layout>
  );
}
export default HomePage;
