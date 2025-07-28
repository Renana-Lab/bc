import web3 from "./web3.js";
import CampaignFactory from "./build/CampaignFactory.json";

const instance = new web3.eth.Contract(
  CampaignFactory.abi,
  "0xECef49ABf7384DfbF6E6084F33c15F82163a20Bd" // Replace with your deployed contract address
);

export default instance;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// WHEN UPDATING THE CONTRACT, ALSO UPDATE THE ADDRESS HERE
// AND IN THE DEPLOY SCRIPT!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!