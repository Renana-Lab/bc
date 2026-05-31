const METAMASK_RDNS = "io.metamask";

const isBrowser = () => typeof window !== "undefined";

const getInjectedProviders = () => {
  if (!isBrowser()) return [];

  const ethereum = window.ethereum;
  const providers = Array.isArray(ethereum?.providers)
    ? ethereum.providers
    : ethereum
    ? [ethereum]
    : [];

  return providers.filter(Boolean);
};

const isMetaMaskProvider = (provider) =>
  Boolean(provider?.isMetaMask || provider?.providerInfo?.rdns === METAMASK_RDNS);

export const getEthereumProvider = () => {
  const providers = getInjectedProviders();
  return providers.find(isMetaMaskProvider) || providers[0] || null;
};

export const waitForEthereumProvider = ({
  timeoutMs = 1800,
  pollIntervalMs = 150,
} = {}) => {
  const existingProvider = getEthereumProvider();
  if (existingProvider || !isBrowser()) {
    return Promise.resolve(existingProvider);
  }

  return new Promise((resolve) => {
    let settled = false;
    let intervalId;
    let timeoutId;

    const finish = (provider = getEthereumProvider()) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("eip6963:announceProvider", handleAnnounce);
      window.removeEventListener("ethereum#initialized", handleInitialized);
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      resolve(provider || null);
    };

    const handleAnnounce = (event) => {
      const provider = event?.detail?.provider;
      if (provider) {
        finish(provider);
      }
    };

    const handleInitialized = () => finish();

    window.addEventListener("eip6963:announceProvider", handleAnnounce);
    window.addEventListener("ethereum#initialized", handleInitialized, {
      once: true,
    });

    window.dispatchEvent(new Event("eip6963:requestProvider"));

    intervalId = window.setInterval(() => {
      const provider = getEthereumProvider();
      if (provider) finish(provider);
    }, pollIntervalMs);

    timeoutId = window.setTimeout(() => finish(), timeoutMs);
  });
};

export const getEthereumAccounts = async () => {
  const provider = await waitForEthereumProvider();
  if (!provider?.request) return [];
  return provider.request({ method: "eth_accounts" });
};

export const requestEthereumAccounts = async () => {
  const provider = await waitForEthereumProvider();
  if (!provider?.request) return [];
  return provider.request({ method: "eth_requestAccounts" });
};
