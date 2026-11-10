import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { getEthereumAccounts, requestEthereumAccounts, getMetaMaskErrorMessage } from "../real_ethereum/ethereumProvider";
import { getWalletAccess, subscribeWalletAccess, startWalletAccess } from "../real_ethereum/walletAccess";

const MetaMaskContext = createContext();
export const useMetaMask = () => useContext(MetaMaskContext);
const requestConnection = async () => {
  try { return { accounts: await requestEthereumAccounts(), error: "" }; }
  catch (error) { return { accounts: [], error: getMetaMaskErrorMessage(error) }; }
};
export const MetaMaskProvider = ({ children }) => {
  const session = useSyncExternalStore(subscribeWalletAccess, getWalletAccess);
  useEffect(startWalletAccess, []);
  const value = useMemo(() => ({
    ...session, isMetaMaskInstalled: Boolean(session.provider),
    lastConnectionError: session.reason, checkIfConnected: getEthereumAccounts, requestConnection,
  }), [session]);
  return <MetaMaskContext.Provider value={value}>{children}</MetaMaskContext.Provider>;
};
