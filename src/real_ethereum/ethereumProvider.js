const METAMASK_RDNS = "io.metamask";
const DEFAULT_WAIT_TIMEOUT_MS = 2200;
const CONNECT_WAIT_TIMEOUT_MS = 6500;

const isBrowser = () => typeof window !== "undefined";

let announcedProviders = [];

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

const rememberProvider = (provider) => {
  if (!provider || announcedProviders.includes(provider)) return;
  announcedProviders = [...announcedProviders, provider];
};

const normalizeAccounts = (accounts) =>
  Array.isArray(accounts) ? accounts.filter(Boolean) : [];

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const readAccounts = async (provider) => {
  if (!provider?.request) return [];
  return normalizeAccounts(await provider.request({ method: "eth_accounts" }));
};

const waitForAccountsChanged = (provider, timeoutMs = 3000) => {
  if (!isBrowser() || !provider?.on) return Promise.resolve([]);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;

    const finish = (accounts = []) => {
      if (settled) return;
      settled = true;
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      window.clearTimeout(timeoutId);
      resolve(normalizeAccounts(accounts));
    };

    const handleAccountsChanged = (accounts) => finish(accounts);

    provider.on("accountsChanged", handleAccountsChanged);
    timeoutId = window.setTimeout(() => finish(), timeoutMs);
  });
};

export const getEthereumProvider = () => {
  const providers = [...getInjectedProviders(), ...announcedProviders];
  return providers.find(isMetaMaskProvider) || providers[0] || null;
};

export const waitForEthereumProvider = ({
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
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
        rememberProvider(provider);
        if (isMetaMaskProvider(provider)) {
          finish(provider);
        }
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
  return readAccounts(provider);
};

export const requestEthereumAccounts = async () => {
  const provider = await waitForEthereumProvider({
    timeoutMs: CONNECT_WAIT_TIMEOUT_MS,
    pollIntervalMs: 120,
  });

  if (!provider?.request) {
    throw new Error(
      "MetaMask was not detected by this browser page. Make sure the extension is installed, enabled for this site, unlocked, and then refresh."
    );
  }

  const requestedAccounts = normalizeAccounts(
    await provider.request({ method: "eth_requestAccounts" })
  );

  if (requestedAccounts.length) return requestedAccounts;

  for (const delayMs of [250, 800]) {
    await wait(delayMs);
    const accounts = await readAccounts(provider);
    if (accounts.length) return accounts;
  }

  const changedAccounts = await waitForAccountsChanged(provider);
  if (changedAccounts.length) return changedAccounts;

  return readAccounts(provider);
};

export const getMetaMaskErrorMessage = (error) => {
  const code = error?.code;
  const message = String(error?.message || "");

  if (code === 4001) {
    return "MetaMask connection was rejected. Please approve the connection request to continue.";
  }

  if (code === -32002) {
    return "MetaMask already has a pending connection request. Open MetaMask and approve or close it, then try again.";
  }

  if (/not detected|no provider|window\.ethereum/i.test(message)) {
    return "MetaMask was not detected by the page. On Mac, check that the extension is enabled for this site, unlock MetaMask, then refresh the page.";
  }

  if (/already processing|request.*pending/i.test(message)) {
    return "MetaMask is already processing a request. Open MetaMask, finish that request, then try again.";
  }

  return (
    message ||
    "MetaMask did not return an account. Please unlock MetaMask, select an account, and try again."
  );
};
