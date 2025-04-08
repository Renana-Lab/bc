import React, { createContext, useState, useContext, useEffect } from 'react';

// Create the context
const MetaMaskContext = createContext();

// Custom hook to use MetaMask context
export const useMetaMask = () => {
  return useContext(MetaMaskContext);
};

// Create a provider component
export const MetaMaskProvider = ({ children }) => {
  const [isMetaMaskInstalled, setIsMetaMaskInstalled] = useState(false);

  useEffect(() => {
    // Check if MetaMask is installed
    if (typeof window.ethereum !== 'undefined') {
      setIsMetaMaskInstalled(true);
    }
  }, []);

  // Check MetaMask connection status and update localStorage
  const checkIfConnected = async () => {

    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      console.log("Connected Accounts:", accounts);
      const isNotConnected = accounts.length === 0;
      localStorage.setItem('notConnected', isNotConnected);
    } catch (error) {
      console.error("Error checking MetaMask connection:", error);
    }
  };

  return (
    <MetaMaskContext.Provider value={{ isMetaMaskInstalled, checkIfConnected }}>
      {children}
    </MetaMaskContext.Provider>
  );
};
