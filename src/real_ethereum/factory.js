import web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";

const instance = new web3.eth.Contract(
  CampaignFactory.abi,
  "0x9F283704e53270E3ae80cdFd0853EE46e3b81869"
);

export default instance;
