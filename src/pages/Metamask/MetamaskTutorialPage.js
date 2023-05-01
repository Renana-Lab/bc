import React, { Component,useState, useCallback } from "react";
import styles from "./metamask.module.scss";
import Layout from "../../components/Layout";
import metamaskImg from "./metamask.jpg";
// import Image from "next/image"; //todo change this to regular image
import Button from "@mui/material/Button";
import { useNavigate } from "react-router-dom";

function MetamaskTutorialPage(){
  const navigate = useNavigate();

  const [notConnected, setNotConnected] = useState(false);
const checkIfConnected = useCallback(
  async ()=>{
        let a = await window.ethereum._state.accounts;
    if (a.length == 0) {
      setNotConnected(true);
    } else {
      navigate("/auctions-list")
      // Router.pushRoute("/auctions-list");
    }
  }
  
) 
return (
        <Layout>
        <div className={styles.metamaskContainer}>
          <div className={styles.checkMetamask}>
            <div className={styles.metamaskImage}>
              {/* <Image
                className={styles.metamaskimg}
                src={metamaskImg}
                height="230"
                width="345"
              /> */}
            </div>

            <div className={styles.metamaskQuestion}>
              <div className={styles.metamaskTitle}>
                Are you logged in to Metamask ?
              </div>
              <div className={styles.metamaskText}>
                Before starting buying/selling data, please make sure you are
                logged in to a metamask account
              </div>
              <div className={styles.metamaskText}>
                If you don't have a metamask account , please follow the
                metamask tutorial to create one and come back to start using our
                blockchain data market
              </div>
              <div className={styles.metamaskButtons}>
                <Button
                  style={{
                    height: "2.5rem",
                    padding: "0.8rem",
                    borderRadius: "1rem",
                    backgroundColor: "#D8DCF0",
                    color: "#002884",
                    fontWeight: "600",
                    border: "1px solid #002884",
                  }}
                  variant="outlined"
                  onClick={(e) => {
                    this.checkIfConnected();
                  }}
                >
                  Yes, I am connected
                </Button>
                <Button
                  style={{
                    height: "2.5rem",
                    padding: "0.8rem",
                    borderRadius: "1rem",
                    backgroundColor: "#D8DCF0",
                    color: "#002884",
                    fontWeight: "600",
                    border: "1px solid #002884",
                  }}
                  variant="outlined"
                >
                  <a
                    style={{
                      color: "#002884",
                    }}
                    href="https://support.metamask.io/hc/en-us/articles/360015489531-Getting-started-with-MetaMask"
                  >
                    No, I don't have a Metamask account
                  </a>
                </Button>
              </div>
            </div>
          </div>
          {{notConnected} && (
            <div>
              <div className={styles.metamaskTutorial}>
                <div className={styles.metamaskIntermediaireTitle}>
                  It seems you aren't connected to a metamask account
                </div>
                <div className={styles.metamaskIntermediaireText}>
                  No worries ! Please follow
                  <a
                    href="https://support.metamask.io/hc/en-us/articles/360015489531-Getting-started-with-MetaMask"
                  >
                    the metamask tutorial
                  </a>
                  to create one or connect to an existing one !
                  <Button
                    style={{
                      marginLeft: "2rem",
                      height: "2.5rem",
                      padding: "0.8rem",
                      borderRadius: "1rem",
                      backgroundColor: "#D8DCF0",
                      color: "#002884",
                      fontWeight: "600",
                      border: "1px solid #002884",
                    }}
                    variant="outlined"
                  >
                    <a
                      style={{
                        color: "#002884",
                      }}
                      href="https://support.metamask.io/hc/en-us/articles/360015489531-Getting-started-with-MetaMask"
                    >
                      Metamask tutorial
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          )}
           {!{notConnected} && (<div className={styles.continue}>
            <Button
              style={{
                float: "right",
                width: "10rem",
                height: "2.5rem",
                borderRadius: "1rem",
                backgroundColor: "#002884",
                color: "#D8DCF0",
                fontWeight: "600",
                border: "1px solid #002884",
              }}
              onClick={(e) => {
                this.checkIfConnected();
              }}
              // disabled={this.props.connectnotConnected}
              variant="outlined"
            >
              Let's start !
            </Button>
          </div>)}
        </div>
      </Layout>
)


}

export default MetamaskTutorialPage;
