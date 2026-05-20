import Web3 from "web3";
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import { getActiveFactoryAddress } from "./marketConfig";

const DEFAULT_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://1rpc.io/sepolia",
];
const HTTP_TIMEOUT_MS = Number(process.env.REACT_APP_RPC_TIMEOUT_MS || 9000);

const RPC_URLS = (
  process.env.REACT_APP_RPC_URLS ||
  process.env.REACT_APP_RPC_URL ||
  DEFAULT_RPC_URLS.join(",")
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const RETRY_DELAY_MS = 2500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (error) => {
  const message = JSON.stringify(error?.message || error || "");
  return (
    message.includes("429") ||
    message.includes("Too Many Requests") ||
    message.includes("Rate limit")
  );
};

const readOnlyWeb3s = RPC_URLS.map(
  (url) =>
    new Web3(
      new Web3.providers.HttpProvider(url, {
        timeout: HTTP_TIMEOUT_MS,
      })
    )
);

let nextProviderIndex = 0;
let injectedProviderRef = null;
let injectedWeb3 = null;

const hasInjectedProvider = () =>
  typeof window !== "undefined" && Boolean(window.ethereum);

const getInjectedWeb3 = () => {
  if (!hasInjectedProvider()) return null;

  if (injectedProviderRef !== window.ethereum || !injectedWeb3) {
    injectedProviderRef = window.ethereum;
    injectedWeb3 = new Web3(window.ethereum);
  }

  return injectedWeb3;
};

const getProviderSequence = (preferInjected = true, allowInjectedFallback = true) => {
  const providers = [];
  const injectedWeb3Instance = getInjectedWeb3();
  const injectedProvider = injectedWeb3Instance
    ? { injected: true, web3: injectedWeb3Instance }
    : null;

  if (injectedProvider && preferInjected) {
    providers.push(injectedProvider);
  }

  readOnlyWeb3s.forEach((_web3Instance, offset) => {
    providers.push({
      injected: false,
      web3: readOnlyWeb3s[(nextProviderIndex + offset) % readOnlyWeb3s.length],
    });
  });

  if (injectedProvider && !preferInjected && allowInjectedFallback) {
    providers.push(injectedProvider);
  }

  return providers;
};

const getWeb3 = () => getProviderSequence(true)[0].web3;

const createFactory = (web3Instance) =>
  new web3Instance.eth.Contract(CampaignFactory.abi, getActiveFactoryAddress());

const createCampaign = (web3Instance, address) =>
  new web3Instance.eth.Contract(Campaign.abi, address);

export const factoryReadOnly = new Proxy(
  {},
  {
    get(_target, prop) {
      const web3Instance = getWeb3();
      const instance = new web3Instance.eth.Contract(
        CampaignFactory.abi,
        getActiveFactoryAddress()
      );
      const value = instance[prop];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

export const campaignReadOnly = (address) => {
  const web3Instance = getWeb3();
  return new web3Instance.eth.Contract(Campaign.abi, address);
};

export const readOnlyCall = async (createCall, retries, options = {}) => {
  let lastError;
  const providers = getProviderSequence(
    options.preferInjected !== false,
    options.allowInjectedFallback !== false
  );
  const maxAttempts = retries ?? providers.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const provider = providers[attempt % providers.length];
    const web3Instance = provider.web3;

    try {
      return await createCall({
        factory: createFactory(web3Instance),
        campaign: (address) => createCampaign(web3Instance, address),
      }).call();
    } catch (error) {
      lastError = error;
      const shouldTryNextProvider = provider.injected || isRateLimitError(error);

      if (!shouldTryNextProvider || attempt === maxAttempts - 1) {
        throw error;
      }

      if (!provider.injected) {
        nextProviderIndex = (nextProviderIndex + 1) % readOnlyWeb3s.length;
      }

      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError;
};

export const readOnlyBatchCall = async (
  createCalls,
  retries,
  options = {}
) => {
  let lastError;
  const providers = getProviderSequence(
    options.preferInjected !== false,
    options.allowInjectedFallback !== false
  );
  const maxAttempts = retries ?? providers.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const provider = providers[attempt % providers.length];
    const web3Instance = provider.web3;

    try {
      const calls = createCalls({
        factory: createFactory(web3Instance),
        campaign: (address) => createCampaign(web3Instance, address),
      });

      if (!calls.length) return [];

      const results = await new Promise((resolve, reject) => {
        const batch = new web3Instance.BatchRequest();
        const responses = new Array(calls.length);
        let remaining = calls.length;

        calls.forEach((call, index) => {
          const onResponse = (error, result) => {
            responses[index] = error
              ? { status: "rejected", reason: error }
              : { status: "fulfilled", value: result };
            remaining -= 1;

            if (remaining === 0) {
              resolve(responses);
            }
          };

          if (typeof call?.call?.request === "function") {
            batch.add(call.call.request({}, onResponse));
            return;
          }

          if (typeof call?.request === "function") {
            batch.add(call.request(onResponse));
            return;
          }

          onResponse(new TypeError("Unsupported batch call object"));
        });

        try {
          batch.execute();
        } catch (error) {
          reject(error);
        }
      });

      const rateLimited = results.some(
        (result) =>
          result?.status === "rejected" && isRateLimitError(result.reason)
      );
      const hasInjectedProviderFailure =
        provider.injected &&
        results.some((result) => result?.status === "rejected");

      if ((rateLimited || hasInjectedProviderFailure) && attempt < maxAttempts - 1) {
        throw (
          results.find(
            (result) =>
              result?.status === "rejected" &&
              (isRateLimitError(result.reason) || hasInjectedProviderFailure)
          )?.reason || new Error("Injected provider batch read failed")
        );
      }

      return results;
    } catch (error) {
      lastError = error;
      const shouldTryNextProvider = provider.injected || isRateLimitError(error);

      if (!shouldTryNextProvider || attempt === maxAttempts - 1) {
        throw error;
      }

      if (!provider.injected) {
        nextProviderIndex = (nextProviderIndex + 1) % readOnlyWeb3s.length;
      }

      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError;
};

export default getWeb3();
