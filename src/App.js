import React from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import HomePage from "./pages/Home/HomePage.js";
import NewAuctionPage from "./pages/NewAuction/NewAuctionPage.js";
import AuctionsListPage from "./pages/AuctionsList/AuctionsListPage.js";
import MetamaskTutorialPage from "./pages/Metamask/MetamaskTutorialPage.js";
import ShowAuctionPage from "./pages/ShowAuction/ShowAuctionPage.js";
import { MetaMaskProvider } from './Context/Context.js';  // Import MetaMaskProvider
import { Toaster } from 'react-hot-toast';


function App() {


  return (
    <MetaMaskProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/metamask-tutorial" element={<MetamaskTutorialPage />} />
          <Route path="/open-auction" element={<NewAuctionPage />} />
          <Route path="/auctions-list" element={<AuctionsListPage />} />
          <Route path="/auction/:address" element={<ShowAuctionPage />} />
        </Routes>
        <Toaster />

    </MetaMaskProvider>
  );
}

// Export the default App component
export default App;

// If needed, also export APPWithRouter (only if you require it)
export function APPWithRouter() {
  const navigate = useNavigate();
  return <App navigate={navigate} />;
}
