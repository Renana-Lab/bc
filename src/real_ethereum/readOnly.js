import Web3 from "web3";
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import { getActiveFactoryAddress } from "./marketConfig";
import { getEthereumProvider } from "./ethereumProvider";

const DEFAULT_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
];
const HTTP_TIMEOUT_MS = Number(process.env.REACT_APP_RPC_TIMEOUT_MS || 9000);
const DEFAULT_PREFER_INJECTED_READS =
  String(process.env.REACT_APP_PREFER_METAMASK_READS || "").toLowerCase() ===
  "true";
const DEFAULT_ALLOW_INJECTED_FALLBACK =
  String(process.env.REACT_APP_ALLOW_METAMASK_READ_FALLBACK || "").toLowerCase() ===
  "true";

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
  const message = JSON.stringify(error?.message || error || "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("usage limit") ||
    message.includes("current plan") ||
    message.includes("higher limits")
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
const contractCacheByWeb3 = new WeakMap();

const getInjectedWeb3 = () => {
  const provider = getEthereumProvider();
  if (!provider) return null;

  if (injectedProviderRef !== provider || !injectedWeb3) {
    injectedProviderRef = provider;
    injectedWeb3 = new Web3(provider);
  }

  return injectedWeb3;
};

const getProviderSequence = (
  preferInjected = DEFAULT_PREFER_INJECTED_READS,
  allowInjectedFallback = DEFAULT_ALLOW_INJECTED_FALLBACK
) => {
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

const getWeb3 = () =>
  getProviderSequence(
    DEFAULT_PREFER_INJECTED_READS,
    DEFAULT_ALLOW_INJECTED_FALLBACK
  )[0].web3;

const normalizeAddress = (address) => String(address || "").toLowerCase();

const getContractCache = (web3Instance) => {
  if (!contractCacheByWeb3.has(web3Instance)) {
    contractCacheByWeb3.set(web3Instance, new Map());
  }

  return contractCacheByWeb3.get(web3Instance);
};

const getCachedContract = (web3Instance, key, abi, address) => {
  const cache = getContractCache(web3Instance);

  if (!cache.has(key)) {
    cache.set(key, new web3Instance.eth.Contract(abi, address));
  }

  return cache.get(key);
};

const createFactory = (web3Instance, factoryAddress = getActiveFactoryAddress()) =>
  getCachedContract(
    web3Instance,
    `factory:${normalizeAddress(factoryAddress)}`,
    CampaignFactory.abi,
    factoryAddress
  );

const createCampaign = (web3Instance, address) =>
  getCachedContract(
    web3Instance,
    `campaign:${normalizeAddress(address)}`,
    Campaign.abi,
    address
  );

export const factoryReadOnly = new Proxy(
  {},
  {
    get(_target, prop) {
      const web3Instance = getWeb3();
      const instance = createFactory(web3Instance);
      const value = instance[prop];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

export const campaignReadOnly = (address) => {
  const web3Instance = getWeb3();
  return createCampaign(web3Instance, address);
};

export const readOnlyCall = async (createCall, retries, options = {}) => {
  let lastError;
  const providers = getProviderSequence(
    options.preferInjected ?? DEFAULT_PREFER_INJECTED_READS,
    options.allowInjectedFallback ?? DEFAULT_ALLOW_INJECTED_FALLBACK
  );
  const maxAttempts = retries ?? providers.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const provider = providers[attempt % providers.length];
    const web3Instance = provider.web3;

    try {
      return await createCall({
        factory: createFactory(web3Instance, options.factoryAddress),
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
    options.preferInjected ?? DEFAULT_PREFER_INJECTED_READS,
    options.allowInjectedFallback ?? DEFAULT_ALLOW_INJECTED_FALLBACK
  );
  const maxAttempts = retries ?? providers.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const provider = providers[attempt % providers.length];
    const web3Instance = provider.web3;

    try {
      const calls = createCalls({
        factory: createFactory(web3Instance, options.factoryAddress),
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
