import web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";

const instance = new web3.eth.Contract(
  CampaignFactory.abi,
  "0x4F10a46Aa079bc989A8f02D6898dCB3B31a867B0" // Replace with your deployed contract address
);

export default instance;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// WHEN UPDATING THE CONTRACT, ALSO UPDATE THE ADDRESS HERE
// AND IN THE DEPLOY SCRIPT!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!