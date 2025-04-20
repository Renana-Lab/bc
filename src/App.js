import React, { useState, useEffect } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import HomePage from "./pages/Home/HomePage.js";
import NewAuctionPage from "./pages/NewAuction/NewAuctionPage.js";
import AuctionsListPage from "./pages/AuctionsList/AuctionsListPage.js";
import MetamaskTutorialPage from "./pages/MetamaskLogin/MetamaskTutorialPage.js";
import MetamaskGuidePage from "./pages/MetamaskGuide/MetamaskGuidePage.js";
import ShowAuctionPage from "./pages/ShowAuction/ShowAuctionPage.js";
import { MetaMaskProvider } from "./Context/Context.js";
import { Toaster } from "react-hot-toast";

function App() {
  const [isMobile, setIsMobile] = useState(false);

  const checkMobile = () => {
    const mobileThreshold = 768;
    setIsMobile(window.innerWidth < mobileThreshold);
  };

  useEffect(() => {
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return (
    <MetaMaskProvider>
      {isMobile ? (
        <>
          <style>
            {`
              .mobile-not-supported {
                min-height: 100vh;
                background: linear-gradient(to bottom, #1e3a8a, #111827);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 1.5rem;
                text-align: center;
                color: #ffffff;
                font-family: Arial, sans-serif;
              }
              .icon-container {
                margin-bottom: 1.5rem;
                animation: pulse 2s infinite;
              }
              .icon-container svg {
                width: 5rem;
                height: 5rem;
                stroke: #60a5fa;
              }
              .mobile-header {
                font-size: 1.875rem;
                font-weight: 800;
                margin-bottom: 1rem;
                line-height: 1.2;
              }
              .mobile-message {
                font-size: 1.125rem;
                color: #d1d5db;
                margin-bottom: 2rem;
                max-width: 20rem;
                line-height: 1.5;
              }
              .help-button {
                background-color: #2563eb;
                color: #ffffff;
                font-size: 1rem;
                font-weight: 600;
                padding: 0.75rem 1.5rem;
                border: none;
                border-radius: 9999px;
                cursor: pointer;
                transition: background-color 0.3s ease;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
              }
              .help-button:hover {
                background-color: #1d4ed8;
              }
              @keyframes pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.1); }
                100% { transform: scale(1); }
              }
              @media (min-width: 640px) {
                .mobile-header {
                  font-size: 2.25rem;
                }
                .mobile-message {
                  font-size: 1.25rem;
                }
              }
            `}
          </style>
          <div className="mobile-not-supported">
            {/* Icon with animation */}
            <div className="icon-container">
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
            </div>
            {/* Header */}
            <h1 className="mobile-header">Mobile Access Not Supported</h1>
            {/* Message */}
            <p className="mobile-message">
              Our blockchain auction platform requires a larger screen for the best experience. Please use a desktop or tablet.
            </p>         
          </div>
        </>
      ) : (
        <>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/metamask-login" element={<MetamaskTutorialPage />} />
            <Route path="/metamask-guide" element={<MetamaskGuidePage />} />
            <Route path="/open-auction" element={<NewAuctionPage />} />
            <Route path="/auctions-list" element={<AuctionsListPage />} />
            <Route path="/auction/:address" element={<ShowAuctionPage />} />
          </Routes>
          <Toaster />
        </>
      )}
    </MetaMaskProvider>
  );
}

export default App;

export function APPWithRouter() {
  const navigate = useNavigate();
  return <App navigate={navigate} />;
}