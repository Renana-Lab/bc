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
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              flexDirection: "row",
              gap: "3rem",
            }}
          >
            <img
              className={styles.metamaskimg}
              src={Welcomepic}
              height="330"
              width="400"
              alt="metamask"
            />
            <div className={styles.introText}>
              <h2 style={{ margin: "0" }}>Welcome</h2>
              <h3 style={{ margin: "0" }}>to our data marketplace.</h3>
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
            style={{
              width: "17rem",
              height: "3rem",
              padding: "0.8rem",
              borderRadius: "1rem",
              backgroundColor: "#002884",
              color: "#D8DCF0",
              fontWeight: "600",
              border: "1px solid #002884",
            }}
            variant="outlined"
            onClick={() => {
              navigate("metamask-tutorial");
            }}
          >
            Continue
          </Button>
          <Button
            style={{
              width: "17rem",
              height: "3rem",
              padding: "0.8rem",
              borderRadius: "1rem",
              backgroundColor: "white",
              color: "#D8DCF0",
              fontWeight: "600",
              border: "1px solid #002884",
            }}
            variant="outlined"
          >
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
