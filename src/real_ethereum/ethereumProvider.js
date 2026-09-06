import { discoverWalletProvider, requireWalletAccess, verifyWalletAccess } from "./walletAccess";

export const getEthereumProvider = discoverWalletProvider;
export const getMetaMaskProvider = discoverWalletProvider;
export const waitForEthereumProvider = async ({ timeoutMs = 2200 } = {}) => {
  const end = Date.now() + timeoutMs;
  do {
    const provider = discoverWalletProvider();
    if (provider) return provider;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < end);
  return null;
};
export const getEthereumAccounts = async () => {
  const session = await verifyWalletAccess();
  return session.status === "connected" ? [session.account] : [];
};
export const requestEthereumAccounts = async () => {
  const provider = await waitForEthereumProvider({ timeoutMs: 6500 });
  if (!provider) throw new Error("MetaMask was not detected. Enable the extension for this site and retry.");
  await provider.request({ method: "eth_requestAccounts" });
  if (provider !== discoverWalletProvider()) throw new Error("Wallet provider changed. Retry the connection.");
  const session = await requireWalletAccess();
  return [session.account];
};
export const getMetaMaskErrorMessage = (error) => {
  if (error?.code === 4001) return "MetaMask connection was rejected. Approve the connection to continue.";
  if (error?.code === -32002) return "MetaMask has a pending request. Open the extension and finish it.";
  return "Could not verify MetaMask access. Unlock the extension, connect an account to this site, and retry.";
};
