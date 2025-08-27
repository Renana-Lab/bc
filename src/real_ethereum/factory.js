import web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";

const instance = new web3.eth.Contract(
  CampaignFactory.abi,
  "0x18244e00edbF44F085F2436bb5322aA3441c5595" // Replace with your deployed contract address
);

export default instance;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// WHEN UPDATING THE CONTRACT, ALSO UPDATE THE ADDRESS HERE
// AND IN THE DEPLOY SCRIPT!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!