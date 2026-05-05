import Web3 from "web3"; // ✅ קלאס המקורי של Web3
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import FACTORY_ADDRESS from "./factoryAddress";

const DEFAULT_WS_URL = "wss://sepolia.infura.io/ws/v3/b27d53291ceb44bd864dbf7b0eb55581";
const WS_URL = process.env.REACT_APP_WS_RPC_URL || DEFAULT_WS_URL;

const web3Socket = new Web3(
  new Web3.providers.WebsocketProvider(WS_URL)
);

const factorySocket = new web3Socket.eth.Contract(CampaignFactory.abi, FACTORY_ADDRESS);
const campaignSocket = (address) =>
  new web3Socket.eth.Contract(Campaign.abi, address);

export { campaignSocket, factorySocket, web3Socket };
