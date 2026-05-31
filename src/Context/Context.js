import React, { createContext, useCallback, useState, useContext, useEffect } from 'react';
import {
  getEthereumAccounts,
  requestEthereumAccounts,
  waitForEthereumProvider,
} from "../real_ethereum/ethereumProvider";

// Create the context
const MetaMaskContext = createContext();

// Custom hook to use MetaMask context
export const useMetaMask = () => {
  return useContext(MetaMaskContext);
};

// Create a provider component
export const MetaMaskProvider = ({ children }) => {
  const [isMetaMaskInstalled, setIsMetaMaskInstalled] = useState(false);
  const [provider, setProvider] = useState(null);

  const refreshProvider = useCallback(async () => {
    const nextProvider = await waitForEthereumProvider();
    setProvider(nextProvider);
    setIsMetaMaskInstalled(Boolean(nextProvider));
    return nextProvider;
  }, []);

  useEffect(() => {
    refreshProvider();

    const handleVisibility = () => {
      if (!document.hidden) {
        refreshProvider();
      }
    };

    window.addEventListener("focus", refreshProvider);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", refreshProvider);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshProvider]);

  // Check MetaMask connection status and update localStorage
  const checkIfConnected = useCallback(async () => {
    try {
      await refreshProvider();
      const accounts = await getEthereumAccounts();
      const isNotConnected = accounts.length === 0;
      localStorage.setItem('notConnected', isNotConnected);
      return accounts;
    } catch (error) {
      console.error("Error checking MetaMask connection:", error);
      localStorage.setItem('notConnected', true);
      return [];
    }
  }, [refreshProvider]);

  const requestConnection = useCallback(async () => {
    try {
      await refreshProvider();
      const accounts = await requestEthereumAccounts();
      const isNotConnected = accounts.length === 0;
      localStorage.setItem('notConnected', isNotConnected);
      return accounts;
    } catch (error) {
      console.error("Error requesting MetaMask connection:", error);
      localStorage.setItem('notConnected', true);
      return [];
    }
  }, [refreshProvider]);

  return (
    <MetaMaskContext.Provider
      value={{ isMetaMaskInstalled, provider, checkIfConnected, requestConnection }}
    >
      {children}
    </MetaMaskContext.Provider>
  );
};
