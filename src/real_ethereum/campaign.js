import web3 from "./web3";
import Campaign from "./build/Campaign.json";

const campaignContractCache = new Map();
const normalizeAddress = (address) => String(address || "").toLowerCase();

const campaign = (address) => {
  const cacheKey = normalizeAddress(address);

  if (!campaignContractCache.has(cacheKey)) {
    campaignContractCache.set(cacheKey, new web3.eth.Contract(Campaign.abi, address));
  }

  return campaignContractCache.get(cacheKey);
};

export default campaign;
