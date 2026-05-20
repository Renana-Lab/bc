import Web3 from "web3"; // ✅ קלאס המקורי של Web3
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import { getActiveFactoryAddress } from "./marketConfig";

const DEFAULT_WS_URL = "wss://sepolia.infura.io/ws/v3/b27d53291ceb44bd864dbf7b0eb55581";
const WS_URL = process.env.REACT_APP_WS_RPC_URL || DEFAULT_WS_URL;

const web3Socket = new Web3(
  new Web3.providers.WebsocketProvider(WS_URL)
);

const createFactorySocket = () =>
  new web3Socket.eth.Contract(CampaignFactory.abi, getActiveFactoryAddress());

const factorySocket = new Proxy(
  {},
  {
    get(_target, prop) {
      const instance = createFactorySocket();
      const value = instance[prop];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

const campaignSocket = (address) =>
  new web3Socket.eth.Contract(Campaign.abi, address);

export { campaignSocket, factorySocket, web3Socket };
