import React, { createContext, useContext, useEffect, useSyncExternalStore } from "react";
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
  return <MetaMaskContext.Provider value={{
    ...session, isMetaMaskInstalled: Boolean(session.provider),
    lastConnectionError: session.reason, checkIfConnected: getEthereumAccounts, requestConnection,
  }}>{children}</MetaMaskContext.Provider>;
};
