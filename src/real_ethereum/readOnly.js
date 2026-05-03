import Web3 from "web3";
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import FACTORY_ADDRESS from "./factoryAddress";

const DEFAULT_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://1rpc.io/sepolia",
];

const RPC_URLS = (
  process.env.REACT_APP_RPC_URLS ||
  process.env.REACT_APP_RPC_URL ||
  DEFAULT_RPC_URLS.join(",")
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const RETRY_DELAY_MS = 900;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (error) => {
  const message = JSON.stringify(error?.message || error || "");
  return message.includes("429") || message.includes("Too Many Requests");
};

const readOnlyWeb3s = RPC_URLS.map(
  (url) => new Web3(new Web3.providers.HttpProvider(url))
);

let nextProviderIndex = 0;

const getWeb3 = (offset = 0) =>
  readOnlyWeb3s[(nextProviderIndex + offset) % readOnlyWeb3s.length];

const createFactory = (web3Instance) =>
  new web3Instance.eth.Contract(CampaignFactory.abi, FACTORY_ADDRESS);

const createCampaign = (web3Instance, address) =>
  new web3Instance.eth.Contract(Campaign.abi, address);

const readOnlyWeb3 = getWeb3();

export const factoryReadOnly = new readOnlyWeb3.eth.Contract(
  CampaignFactory.abi,
  FACTORY_ADDRESS
);

export const campaignReadOnly = (address) =>
  new readOnlyWeb3.eth.Contract(Campaign.abi, address);

export const readOnlyCall = async (createCall, retries = RPC_URLS.length + 1) => {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const web3Instance = getWeb3(attempt);

    try {
      return await createCall({
        factory: createFactory(web3Instance),
        campaign: (address) => createCampaign(web3Instance, address),
      }).call();
    } catch (error) {
      lastError = error;

      if (!isRateLimitError(error) || attempt === retries - 1) {
        throw error;
      }

      nextProviderIndex = (nextProviderIndex + 1) % readOnlyWeb3s.length;
      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError;
};

export default readOnlyWeb3;
