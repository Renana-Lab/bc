import React, { Component, useCallback , useState } from "react";
import Layout from "./../../components/Layout";
import factory from "./../../real_ethereum/factory";
import web3 from "./../../real_ethereum/web3";
// import { Router } from "./../../routes";
import styles from "./new.module.scss";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import TextField from "@mui/material/TextField";
import { Link, Navigate, useNavigate } from 'react-router-dom';
// import { Link } from "./../../routes";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import CircularProgress from "@mui/material/CircularProgress";
import { library } from "@fortawesome/fontawesome-svg-core";
import { faQuestionCircle } from "@fortawesome/free-solid-svg-icons";
import { dividerClasses } from "@mui/material";

function NewAuctionPage(){
  const [displayBidExplanation, setDisplayBidExplanation] = useState(false);
  const [displayDataForSaleExplanation, setDisplayDataForSaleExplanation] = useState(false);
  const [displayDataDescriptionExplanation, setDisplayDataDescriptionExplanation] = useState(false);
  const [displayAuctionTimeExplanation, setDisplayAuctionTimeExplanation] = useState(false);
  const [minimumContribution, setMinimumContribution] = useState("");
  const [auctionDuration, setAuctionDuration] = useState("");
  const [CreateAuctionIsLoading, setCreateAuctionIsLoading] = useState(false);
  const [dataForSell, setDataForSell] = useState("");
  const [dataDescription, setDataDescription] = useState("");


  const navigate = useNavigate();
  const onSubmit = useCallback(
    async ()=>{
      //     event.preventDefault();
      setCreateAuctionIsLoading(true);
    try {
      const accounts = await web3.eth.getAccounts();
      await factory.methods
        .createCampaign(
          minimumContribution,
          dataForSell,
          dataDescription,
          auctionDuration
        )
        .send({
          from: accounts[0],
        });
        navigate("/auctions-list");
    } catch (err) {}
    setCreateAuctionIsLoading(false);
  }
  )
  const onReveal = useCallback(
    (event)=>{
    if (event.currentTarget.id == "minBid") {
      setDisplayBidExplanation(true);
    } else if (event.currentTarget.id == "dataForSale") {
      setDisplayDataForSaleExplanation(true);
    } else if (event.currentTarget.id == "dataDescription") {
      setDisplayDataDescriptionExplanation(true);
    } else if (event.currentTarget.id == "auctionTime") {
      setDisplayAuctionTimeExplanation(true);
    }
    }

  )
  return (
    <div className={styles.background}>
    <Layout>
      <div className={styles.direction}>
        <img
          className={styles.Image}
          src="https://www.vancouverfringe.com/wp-content/uploads/2023/02/Silent-Auction-Blog.jpg"
          alt=""
        ></img>
        <FormControl className={styles.form} onSubmit={onSubmit}>
          <h3 className={styles.introductionTitle}>Create Auction</h3>
          <div className={styles.tooltip}>
            <label className={styles.tooltiplabe}>
              Minimum Bid (in Wei)
              <button
                onClick={onReveal}
                id="minBid"
                className={styles.circleIcon}
              >
                <FontAwesomeIcon icon={["fas", "question-circle"]} />
              </button>
              <div className={styles.description}>
                {{displayBidExplanation} && (
                  <div>
                    <div>
                      Wei is the smallest (base) unit of Ether , you can
                      convert between Ether units
                      <a href="https://eth-converter.com/"> here</a>
                    </div>
                  </div>
                )}
              </div>
            </label>
          </div>
          <TextField
            sx={{ width: "85%" }}
            inputProps={{
              style: {
                height: "0.6rem",
              },
            }}
            // labelPosition="right"
            value={minimumContribution}
            onChange={(event) =>
              setMinimumContribution(event.target.value)
              // this.setState({ minimumContribution: event.target.value })
            }
          />
          <div className={styles.tooltip}>
            <label className={styles.tooltiplabe}>
              Description of the Data
              <button
                onClick={onReveal}
                id="dataDescription"
                className={styles.circleIcon}
              >
                <FontAwesomeIcon icon={["fas", "question-circle"]} />
              </button>
              <div className={styles.description}>
                {{displayDataDescriptionExplanation} && (
                  <span>
                    Describe friendly what the data are about ,so sellers
                    have more information (e.g. : my age)
                  </span>
                )}
              </div>
            </label>
          </div>
          <TextField
            sx={{ width: "85%" }}
            inputProps={{
              style: {
                height: "0.6rem",
              },
            }}
            // labelPosition="right"
            value={dataDescription}
            onChange={(event) =>
              setDataDescription(event.target.value)
            }
          />
          <div className={styles.tooltip}>
            <label className={styles.tooltiplabe}>
              Data For Sale
              <button
                onClick={onReveal}
                id="dataForSale"
                className={styles.circleIcon}
              >
                <FontAwesomeIcon icon={["fas", "question-circle"]} />
              </button>
              <div className={styles.description}>
                {{displayDataForSaleExplanation} && (
                  <span>
                    Insert here the data that you are interested to sell
                  </span>
                )}
              </div>
            </label>
          </div>
          <TextField
            sx={{ width: "85%" }}
            inputProps={{
              style: {
                height: "0.6rem",
              },
            }}
            // labelPosition="right"
            value={dataForSell}
            onChange={(event) => {
              setDataForSell(event.target.value)
              // this.setState({ dataForSell: event.target.value });
            }}
          />
          <div className={styles.tooltip}>
            <label className={styles.tooltiplabe}>
              How much time will your auction take ? (1-30 mins)
              <button
                onClick={onReveal}
                id="auctionTime"
                className={styles.circleIcon}
              >
                <FontAwesomeIcon icon={["fas", "question-circle"]} />
              </button>
              <div className={styles.description}>
                {{displayAuctionTimeExplanation} && (
                  <span>Specify the length of the auction in minutes</span>
                )}
              </div>
            </label>
          </div>
          <TextField
            sx={{ width: "85%" }}
            inputProps={{
              style: {
                height: "0.6rem",
              },
            }}
            // labelPosition="right"
            type="number"
            step="1"
            min="1"
            max="30"
            value={auctionDuration}
            onChange={(event) =>
              // this.setState({ auctionDuration: event.target.value })
              setAuctionDuration(event.target.value)
            }
          />
          <div className={styles.newButton}>
            <Button
              style={{
                marginTop: "2rem",
                height: "2.5rem",
                padding: "0.8rem",
                borderRadius: "1rem",
                backgroundColor: "#002884",
                color: "#D8DCF0",
                fontWeight: "600",
                border: "1px solid #002884",
                minWidth: "11rem",
              }}
              type="submit"
              onClick={onSubmit}
            >
              {!{CreateAuctionIsLoading} ? (
                <span>Create Auction</span>
              ) : (
                <CircularProgress className={styles.progress} size={20} />
              )}
            </Button>
          </div>
        </FormControl>
      </div>
      {/* <Link route={`/auctions-list`}> */}
        <Button
          style={{
            marginTop: "6.5rem",
            float: "left",
            width: "20rem",
            height: "2.5rem",
            borderRadius: "1rem",
            backgroundColor: "#002884",
            color: "#D8DCF0",
            fontWeight: "600",
            border: "1px solid #002884",
          }}
          onClick={() => {
            navigate('/auctions-list')// this.props.navigate("/metamask-tutorial");
            // <Link to="/metamask-tutorial"/>
          }}
          variant="outlined"
        >
                            

          {/* <a
            style={{
              color: "#D8DCF0",
            }}
          >
            Return To Auctions Main Screen
          </a> */}
        </Button>
      {/* </Link> */}
    </Layout>
  </div>
  )
}
// class NewAuctionPage extends Component {
//   state = {
//     minimumContribution: "",
//     CreateAuctionIsLoading: false,
//     dataForSell: "",
//     dataDescription: "",
//     auctionDuration: "",
//     displayBidExplanation: false,
//     displayDataForSaleExplanation: false,
//     displayDataDescriptionExplanation: false,
//     displayAuctionTimeExplanation: false,
//   };

//   onSubmit = async (event) => {
//     event.preventDefault();
//     this.setState({ CreateAuctionIsLoading: true });
//     try {
//       const accounts = await web3.eth.getAccounts();
//       await factory.methods
//         .createCampaign(
//           this.state.minimumContribution,
//           this.state.dataForSell,
//           this.state.dataDescription,
//           this.state.auctionDuration
//         )
//         .send({
//           from: accounts[0],
//         });

//       // Router.pushRoute("/auctions-list");
//     } catch (err) {}
//     this.setState({ CreateAuctionIsLoading: false });
//   };
//   onReveal = (event) => {
//     if (event.currentTarget.id == "minBid") {
//       this.setState({ displayBidExplanation: true });
//     } else if (event.currentTarget.id == "dataForSale") {
//       this.setState({ displayDataForSaleExplanation: true });
//     } else if (event.currentTarget.id == "dataDescription") {
//       this.setState({ displayDataDescriptionExplanation: true });
//     } else if (event.currentTarget.id == "auctionTime") {
//       this.setState({ displayAuctionTimeExplanation: true });
//     }
//   };
//   render() {
//     library.add(faQuestionCircle);
//     return (
//       <div className={styles.background}>
//         <Layout>
//           <div className={styles.direction}>
//             <img
//               className={styles.Image}
//               src="https://www.vancouverfringe.com/wp-content/uploads/2023/02/Silent-Auction-Blog.jpg"
//               alt=""
//             ></img>
//             <FormControl className={styles.form} onSubmit={this.onSubmit}>
//               <h3 className={styles.introductionTitle}>Create Auction</h3>
//               <div className={styles.tooltip}>
//                 <label className={styles.tooltiplabe}>
//                   Minimum Bid (in Wei)
//                   <button
//                     onClick={this.onReveal}
//                     id="minBid"
//                     className={styles.circleIcon}
//                   >
//                     <FontAwesomeIcon icon={["fas", "question-circle"]} />
//                   </button>
//                   <div className={styles.description}>
//                     {this.state.displayBidExplanation && (
//                       <div>
//                         <div>
//                           Wei is the smallest (base) unit of Ether , you can
//                           convert between Ether units
//                           <a href="https://eth-converter.com/"> here</a>
//                         </div>
//                       </div>
//                     )}
//                   </div>
//                 </label>
//               </div>
//               <TextField
//                 sx={{ width: "85%" }}
//                 inputProps={{
//                   style: {
//                     height: "0.6rem",
//                   },
//                 }}
//                 // labelPosition="right"
//                 value={this.state.minimumContribution}
//                 onChange={(event) =>
//                   this.setState({ minimumContribution: event.target.value })
//                 }
//               />
//               <div className={styles.tooltip}>
//                 <label className={styles.tooltiplabe}>
//                   Description of the Data
//                   <button
//                     onClick={this.onReveal}
//                     id="dataDescription"
//                     className={styles.circleIcon}
//                   >
//                     <FontAwesomeIcon icon={["fas", "question-circle"]} />
//                   </button>
//                   <div className={styles.description}>
//                     {this.state.displayDataDescriptionExplanation && (
//                       <span>
//                         Describe friendly what the data are about ,so sellers
//                         have more information (e.g. : my age)
//                       </span>
//                     )}
//                   </div>
//                 </label>
//               </div>
//               <TextField
//                 sx={{ width: "85%" }}
//                 inputProps={{
//                   style: {
//                     height: "0.6rem",
//                   },
//                 }}
//                 // labelPosition="right"
//                 value={this.state.dataDescription}
//                 onChange={(event) =>
//                   this.setState({ dataDescription: event.target.value })
//                 }
//               />
//               <div className={styles.tooltip}>
//                 <label className={styles.tooltiplabe}>
//                   Data For Sale
//                   <button
//                     onClick={this.onReveal}
//                     id="dataForSale"
//                     className={styles.circleIcon}
//                   >
//                     <FontAwesomeIcon icon={["fas", "question-circle"]} />
//                   </button>
//                   <div className={styles.description}>
//                     {this.state.displayDataForSaleExplanation && (
//                       <span>
//                         Insert here the data that you are interested to sell
//                       </span>
//                     )}
//                   </div>
//                 </label>
//               </div>
//               <TextField
//                 sx={{ width: "85%" }}
//                 inputProps={{
//                   style: {
//                     height: "0.6rem",
//                   },
//                 }}
//                 // labelPosition="right"
//                 value={this.state.dataForSell}
//                 onChange={(event) => {
//                   this.setState({ dataForSell: event.target.value });
//                 }}
//               />
//               <div className={styles.tooltip}>
//                 <label className={styles.tooltiplabe}>
//                   How much time will your auction take ? (1-30 mins)
//                   <button
//                     onClick={this.onReveal}
//                     id="auctionTime"
//                     className={styles.circleIcon}
//                   >
//                     <FontAwesomeIcon icon={["fas", "question-circle"]} />
//                   </button>
//                   <div className={styles.description}>
//                     {this.state.displayAuctionTimeExplanation && (
//                       <span>Specify the length of the auction in minutes</span>
//                     )}
//                   </div>
//                 </label>
//               </div>
//               <TextField
//                 sx={{ width: "85%" }}
//                 inputProps={{
//                   style: {
//                     height: "0.6rem",
//                   },
//                 }}
//                 // labelPosition="right"
//                 type="number"
//                 step="1"
//                 min="1"
//                 max="30"
//                 value={this.state.auctionDuration}
//                 onChange={(event) =>
//                   this.setState({ auctionDuration: event.target.value })
//                 }
//               />
//               <div className={styles.newButton}>
//                 <Button
//                   style={{
//                     marginTop: "2rem",
//                     height: "2.5rem",
//                     padding: "0.8rem",
//                     borderRadius: "1rem",
//                     backgroundColor: "#002884",
//                     color: "#D8DCF0",
//                     fontWeight: "600",
//                     border: "1px solid #002884",
//                     minWidth: "11rem",
//                   }}
//                   type="submit"
//                   onClick={this.onSubmit}
//                 >
//                   {!this.state.CreateAuctionIsLoading ? (
//                     <span>Create Auction</span>
//                   ) : (
//                     <CircularProgress className={styles.progress} size={20} />
//                   )}
//                 </Button>
//               </div>
//             </FormControl>
//           </div>
//           {/* <Link route={`/auctions-list`}> */}
//             <Button
//               style={{
//                 marginTop: "6.5rem",
//                 float: "left",
//                 width: "20rem",
//                 height: "2.5rem",
//                 borderRadius: "1rem",
//                 backgroundColor: "#002884",
//                 color: "#D8DCF0",
//                 fontWeight: "600",
//                 border: "1px solid #002884",
//               }}
//               variant="outlined"
//             >
//               <a
//                 style={{
//                   color: "#D8DCF0",
//                 }}
//               >
//                 Return To Auctions Main Screen
//               </a>
//             </Button>
//           {/* </Link> */}
//         </Layout>
//       </div>
//     );
//   }
// }

export default NewAuctionPage;
