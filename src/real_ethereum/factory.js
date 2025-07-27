import web3 from "./web3.js";
import CampaignFactory from "./build/CampaignFactory.json";

const instance = new web3.eth.Contract(
  CampaignFactory.abi,
  "0xcC856dDba318f872b7c3E6ca957f5437421890f6" // Replace with your deployed contract address
);

export default instance;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// WHEN UPDATING THE CONTRACT, ALSO UPDATE THE ADDRESS HERE
// AND IN THE DEPLOY SCRIPT!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!