import React, { Component } from "react";
import styles from "./home.module.scss";
import Layout from "../../components/Layout";
import Button from "@mui/material/Button";
import { Link, Navigate, useNavigate } from 'react-router-dom';
// import { Navigate, useNavigate } from "react-router-dom";
// import { withRouter } from 'react-router';
// import { withRouter } from 'react-router-dom';
// import { Routes } from "../../routes.js";
// class HomePage extends Component {
//   onContinue() {
//     this.props.navigate("/metamask-tutorial");
//     // this.props.history.push('/metamask-tutorial');

//     // Router.pushRoute("/metamask-tutorial");
//   }
//   render() {
//     return (
//       <Layout>
//         aaaa
//         <div className={styles.container}>
//           <div className={styles.imageHome}>
//             <div className={styles.welcomeText}>Welcome</div>
//           </div>
//           <div className={styles.contentContainer}>
//             <div className={styles.blueText}>to our data market platform</div>
//             <div className={styles.introText}>
//               This is a blockchain based research platform, for running
//               <div></div> auctions of personal data using cryptocurrency.{" "}
//               <div></div> Each auction lasts up to 30 mins.
//             </div>
//             <div className={styles.buttonsContainer}>
//               <Button
//                 style={{
//                   width: "10rem",
//                   height: "2.5rem",
//                   padding: "0.8rem",
//                   borderRadius: "1rem",
//                   backgroundColor: "#002884",
//                   color: "#D8DCF0",
//                   fontWeight: "600",
//                   border: "1px solid #002884",
//                 }}
//                 variant="outlined"
//                 onClick={(e) => {
//                   this.onContinue()
//                   // <Navigate to="/metamask-tutorial"/>
//                 }}
//               >
//                 Continue
//               </Button>
//               <Button
//                 style={{
//                   width: "10rem",
//                   height: "2.5rem",
//                   padding: "0.8rem",
//                   borderRadius: "1rem",
//                   backgroundColor: "#002884",
//                   color: "#D8DCF0",
//                   fontWeight: "600",
//                   border: "1px solid #002884",
//                 }}
//                 variant="outlined"
//               >
//                 <a
//                   style={{
//                     color: "#D8DCF0",
//                   }}
//                   href="https://www.mturk.com/"
//                 >
//                   No Thanks
//                 </a>
//               </Button>
//             </div>
//           </div>
//         </div>
//       </Layout>
//     );
//   }
// }
// // export default HomePage;
function HomePage(){
  const navigate = useNavigate();
  return (
         <Layout>
     <div className={styles.container}>
          <div className={styles.imageHome}>
             <div className={styles.welcomeText}>Welcome</div>
          </div>
          <div className={styles.contentContainer}>
            <div className={styles.blueText}>to our data market platform</div>
             <div className={styles.introText}>
              This is a blockchain based research platform, for running
               <div></div> auctions of personal data using cryptocurrency.{" "}
              <div></div> Each auction lasts up to 30 mins.
             </div>
            <div className={styles.buttonsContainer}>
              <Button
                style={{
                  width: "10rem",
                  height: "2.5rem",
                  padding: "0.8rem",
                  borderRadius: "1rem",
                  backgroundColor: "#002884",
                  color: "#D8DCF0",
                  fontWeight: "600",
                  border: "1px solid #002884",
                }}
                variant="outlined"
                onClick={() => {
                  navigate('open-auction')
// this.props.navigate("/metamask-tutorial");
                  // <Link to="/metamask-tutorial"/>
                }}
              >
                Continue
              </Button>
              <Button
                style={{
                  width: "10rem",
                  height: "2.5rem",
                  padding: "0.8rem",
                  borderRadius: "1rem",
                  backgroundColor: "#002884",
                  color: "#D8DCF0",
                  fontWeight: "600",
                  border: "1px solid #002884",
                }}
                variant="outlined"
              >
                <a
                  style={{
                    color: "#D8DCF0",
                  }}
                  href="https://www.mturk.com/"
                >
                  No Thanks
                </a>
              </Button>
            </div>
          </div>
        </div>
      </Layout>
  )
}
export default HomePage;
