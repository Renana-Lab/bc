import Web3 from "web3";
import CampaignFactory from "./build/CampaignFactory.json";
import Campaign from "./build/Campaign.json";
import { getActiveFactoryAddress } from "./marketConfig";
import { getEthereumProvider } from "./ethereumProvider";
import {
  createRpcPoolError,
  getConfiguredRpcUrls,
  getHealthyRpcUrls,
  isRpcProviderFailure,
  markRpcProviderFailure,
  markRpcProviderSuccess,
  scheduleRpcRequest,
} from "./rpcConfig";

const HTTP_TIMEOUT_MS = Number(process.env.REACT_APP_RPC_TIMEOUT_MS || 9000);
const DEFAULT_PREFER_INJECTED_READS =
  String(process.env.REACT_APP_PREFER_METAMASK_READS || "true").toLowerCase() !==
  "false";
const DEFAULT_ALLOW_INJECTED_FALLBACK =
  String(process.env.REACT_APP_ALLOW_METAMASK_READ_FALLBACK || "true").toLowerCase() !==
  "false";

const RPC_URLS = getConfiguredRpcUrls();

const RETRY_DELAY_MS = 80;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readOnlyWeb3s = RPC_URLS.map((url) => ({
  url,
  web3: new Web3(
      new Web3.providers.HttpProvider(url, {
        timeout: HTTP_TIMEOUT_MS,
      })
    ),
}));

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

  const healthyUrls = new Set(getHealthyRpcUrls(RPC_URLS));
  const availableProviders = readOnlyWeb3s.filter(({ url }) => healthyUrls.has(url));
  const providerOffset = availableProviders.length
    ? nextProviderIndex % availableProviders.length
    : 0;
  availableProviders.forEach((_provider, offset) => {
    providers.push({
      injected: false,
      ...availableProviders[(providerOffset + offset) % availableProviders.length],
    });
  });
  if (availableProviders.length) {
    nextProviderIndex = (providerOffset + 1) % availableProviders.length;
  }

  if (injectedProvider && !preferInjected && allowInjectedFallback) {
    providers.push(injectedProvider);
  }

  return providers;
};

const getWeb3 = () =>
  (getProviderSequence(
    DEFAULT_PREFER_INJECTED_READS,
    DEFAULT_ALLOW_INJECTED_FALLBACK
  )[0] || readOnlyWeb3s[0]).web3;

const normalizeAddress = (address) => String(address || "").toLowerCase();

const executeProviderRequest = (provider, operation) =>
  provider.injected
    ? operation()
    : scheduleRpcRequest(provider.url, operation);

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
  const providerFailures = [];
  const providers = getProviderSequence(
    options.preferInjected ?? DEFAULT_PREFER_INJECTED_READS,
    options.allowInjectedFallback ?? DEFAULT_ALLOW_INJECTED_FALLBACK
  );
  if (!providers.length) throw createRpcPoolError([], RPC_URLS);
  const maxAttempts = retries ?? providers.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const provider = providers[attempt % providers.length];
    const web3Instance = provider.web3;

    try {
      const startedAt = Date.now();
      const value = await executeProviderRequest(provider, () =>
        createCall({
          factory: createFactory(web3Instance, options.factoryAddress),
          campaign: (address) => createCampaign(web3Instance, address),
        }).call(),
      );
      if (!provider.injected) {
        markRpcProviderSuccess(provider.url, Date.now() - startedAt);
      }
      return value;
    } catch (error) {
      lastError = error;
      const shouldTryNextProvider = provider.injected || isRpcProviderFailure(error);

      if (!provider.injected && isRpcProviderFailure(error)) {
        markRpcProviderFailure(provider.url, error);
        providerFailures.push({ url: provider.url, error });
      }

      if (!shouldTryNextProvider || attempt === maxAttempts - 1) {
        if (isRpcProviderFailure(error) && providerFailures.length) {
          throw createRpcPoolError(providerFailures, RPC_URLS);
        }
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

export const readOnlyExecute = async (operation, retries, options = {}) => {
  let lastError;
  const providerFailures = [];
  const providers = getProviderSequence(
    options.preferInjected ?? DEFAULT_PREFER_INJECTED_READS,
    options.allowInjectedFallback ?? DEFAULT_ALLOW_INJECTED_FALLBACK
  );
  if (!providers.length) throw createRpcPoolError([], RPC_URLS);
  const maxAttempts = retries ?? providers.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const provider = providers[attempt % providers.length];
    const web3Instance = provider.web3;
    try {
      const startedAt = Date.now();
      const value = await executeProviderRequest(provider, () =>
        operation({
          web3: web3Instance,
          factory: createFactory(web3Instance, options.factoryAddress),
          campaign: (address) => createCampaign(web3Instance, address),
        }),
      );
      if (!provider.injected) {
        markRpcProviderSuccess(provider.url, Date.now() - startedAt);
      }
      return value;
    } catch (error) {
      lastError = error;
      const shouldTryNextProvider = provider.injected || isRpcProviderFailure(error);
      if (!provider.injected && isRpcProviderFailure(error)) {
        markRpcProviderFailure(provider.url, error);
        providerFailures.push({ url: provider.url, error });
      }
      if (!shouldTryNextProvider || attempt === maxAttempts - 1) {
        if (isRpcProviderFailure(error) && providerFailures.length) {
          throw createRpcPoolError(providerFailures, RPC_URLS);
        }
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
  const providerFailures = [];
  const providers = getProviderSequence(
    options.preferInjected ?? DEFAULT_PREFER_INJECTED_READS,
    options.allowInjectedFallback ?? DEFAULT_ALLOW_INJECTED_FALLBACK
  );
  if (!providers.length) throw createRpcPoolError([], RPC_URLS);
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

      const startedAt = Date.now();
      const results = await executeProviderRequest(
        provider,
        () => new Promise((resolve, reject) => {
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
        }),
      );

      const rateLimited = results.some(
        (result) =>
          result?.status === "rejected" && isRpcProviderFailure(result.reason)
      );
      const hasInjectedProviderFailure =
        provider.injected &&
        results.some((result) => result?.status === "rejected");

      if (rateLimited || hasInjectedProviderFailure) {
        throw (
          results.find(
            (result) =>
              result?.status === "rejected" &&
              (isRpcProviderFailure(result.reason) || hasInjectedProviderFailure)
          )?.reason || new Error("Injected provider batch read failed")
        );
      }

      if (!provider.injected) {
        markRpcProviderSuccess(provider.url, Date.now() - startedAt);
      }
      return results;
    } catch (error) {
      lastError = error;
      const shouldTryNextProvider = provider.injected || isRpcProviderFailure(error);

      if (!provider.injected && isRpcProviderFailure(error)) {
        markRpcProviderFailure(provider.url, error);
        providerFailures.push({ url: provider.url, error });
      }

      if (!shouldTryNextProvider || attempt === maxAttempts - 1) {
        if (isRpcProviderFailure(error) && providerFailures.length) {
          throw createRpcPoolError(providerFailures, RPC_URLS);
        }
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
