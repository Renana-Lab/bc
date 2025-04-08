import React from "react";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import HomePage from "./pages/Home/HomePage";
import NewAuctionPage from "./pages/NewAuction/NewAuctionPage";
import AuctionsListPage from "./pages/AuctionsList/AuctionsListPage";
import MetamaskTutorialPage from "./pages/Metamask/MetamaskTutorialPage";
import ShowAuctionPage from "./pages/ShowAuction/ShowAuctionPage";
function Routes1() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/metamask-tutorial" element={<MetamaskTutorialPage />} />
        <Route path="/auctions-list" element={<AuctionsListPage />} />
        <Route path="/open-auction" element={<NewAuctionPage />} />
        <Route path="/auction/:address" element={<ShowAuctionPage />} />
      </Routes>
    </Router>
  );
}
export default Routes1;
