import web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";
import FACTORY_ADDRESS from "./factoryAddress";

const instance = new web3.eth.Contract(
  CampaignFactory.abi,
  FACTORY_ADDRESS
);

export default instance;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// WHEN UPDATING THE CONTRACT, ALSO UPDATE THE ADDRESS HERE
// AND IN THE DEPLOY SCRIPT!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
