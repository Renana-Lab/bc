import web3 from "./web3";
import Campaign from "./build/Campaign.json";
import ProtectedCampaign from "./build/ProtectedCampaign.json";

const campaignContractCache = new Map();
const normalizeAddress = (address) => String(address || "").toLowerCase();

const campaign = (address) => {
  const cacheKey = normalizeAddress(address);

  if (!campaignContractCache.has(cacheKey)) {
    campaignContractCache.set(cacheKey, new web3.eth.Contract(process.env.REACT_APP_PROTECTED_MARKET === "true" ? ProtectedCampaign.abi : Campaign.abi, address));
  }

  return campaignContractCache.get(cacheKey);
};

export default campaign;
