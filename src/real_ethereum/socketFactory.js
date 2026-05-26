import Web3 from "web3";
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import { getActiveFactoryAddress } from "./marketConfig";

const DEFAULT_WS_URL = "wss://sepolia.infura.io/ws/v3/b27d53291ceb44bd864dbf7b0eb55581";
const WS_URL = process.env.REACT_APP_WS_RPC_URL || DEFAULT_WS_URL;
const LIVE_EVENTS_DISABLED =
  String(process.env.REACT_APP_DISABLE_LIVE_EVENTS || "").toLowerCase() === "true";

let web3SocketInstance = null;
const factorySocketCache = new Map();
const campaignSocketCache = new Map();

const normalizeAddress = (address) => String(address || "").toLowerCase();

const isSafari = () => {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  return /safari/i.test(userAgent) && !/chrome|chromium|android/i.test(userAgent);
};

export const canUseLiveEvents = () => {
  if (LIVE_EVENTS_DISABLED) return false;
  if (typeof window === "undefined") return false;
  if (!WS_URL) return false;
  return true;
};

export const shouldLimitLiveEventLoad = () => {
  if (typeof navigator === "undefined") return false;
  return Boolean(navigator.connection?.saveData) || isSafari();
};

const getWeb3Socket = () => {
  if (!canUseLiveEvents()) {
    throw new Error("Live contract events are disabled");
  }

  if (!web3SocketInstance) {
    web3SocketInstance = new Web3(
      new Web3.providers.WebsocketProvider(WS_URL, {
        reconnect: {
          auto: true,
          delay: 5000,
          maxAttempts: 5,
          onTimeout: false,
        },
      })
    );
  }

  return web3SocketInstance;
};

const createFactorySocket = () => {
  const factoryAddress = getActiveFactoryAddress();
  const key = normalizeAddress(factoryAddress);

  if (!factorySocketCache.has(key)) {
    const socket = getWeb3Socket();
    factorySocketCache.set(
      key,
      new socket.eth.Contract(CampaignFactory.abi, factoryAddress)
    );
  }

  return factorySocketCache.get(key);
};

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

const campaignSocket = (address) => {
  const key = normalizeAddress(address);

  if (!campaignSocketCache.has(key)) {
    const socket = getWeb3Socket();
    campaignSocketCache.set(
      key,
      new socket.eth.Contract(Campaign.abi, address)
    );
  }

  return campaignSocketCache.get(key);
};

const web3Socket = new Proxy(
  {},
  {
    get(_target, prop) {
      const instance = getWeb3Socket();
      const value = instance[prop];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

export { campaignSocket, factorySocket, web3Socket };
