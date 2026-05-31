import web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";
import { getActiveFactoryAddress } from "./marketConfig";

const factoryContractCache = new Map();
const normalizeAddress = (address) => String(address || "").toLowerCase();

export const getFactoryContract = () => {
  const factoryAddress = getActiveFactoryAddress();
  const cacheKey = normalizeAddress(factoryAddress);

  if (!factoryContractCache.has(cacheKey)) {
    factoryContractCache.set(
      cacheKey,
      new web3.eth.Contract(CampaignFactory.abi, factoryAddress)
    );
  }

  return factoryContractCache.get(cacheKey);
};

const factory = new Proxy(
  {},
  {
    get(_target, prop) {
      const instance = getFactoryContract();
      const value = instance[prop];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

export default factory;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// Factory addresses are selected through marketConfig.js.
// Configure REACT_APP_FACTORY_ADDRESS per branch when deploying a new factory.
// The UI intentionally exposes one active contract per build.

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
