import Web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";

const FACTORY_ADDRESS = "0xCf77A40535908Ae58c687A4A77D21259822968B8";

const web3Socket = new Web3(
  new Web3.providers.WebsocketProvider("wss://sepolia.infura.io/ws/v3/b27d53291ceb44bd864dbf7b0eb55581")
);

const factorySocket = new web3Socket.eth.Contract(CampaignFactory.abi, FACTORY_ADDRESS);

export { factorySocket, web3Socket };
