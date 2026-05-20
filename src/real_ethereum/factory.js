import web3 from "./web3";
import CampaignFactory from "./build/CampaignFactory.json";
import { getActiveFactoryAddress } from "./marketConfig";

export const getFactoryContract = () =>
  new web3.eth.Contract(CampaignFactory.abi, getActiveFactoryAddress());

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
// Configure REACT_APP_REAL_FACTORY_ADDRESS and REACT_APP_DEV_FACTORY_ADDRESS
// to switch between real and development markets from the UI.

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
