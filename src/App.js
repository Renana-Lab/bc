import React, { lazy, Suspense, useState, useEffect } from "react";
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { MetaMaskProvider, useMetaMask } from "./Context/Context.js";
import { Toaster } from "react-hot-toast";
import PageSeo from "./components/Seo.js";

const HomePage = lazy(() => import("./pages/Home/HomePage.js"));
const NewAuctionPage = lazy(() => import("./pages/NewAuction/NewAuctionPage.js"));
const AuctionsListPage = lazy(() => import("./pages/AuctionsList/AuctionsListPage.js"));
const MetamaskTutorialPage = lazy(() =>
  import("./pages/MetamaskLogin/MetamaskTutorialPage.js")
);
const MetamaskGuidePage = lazy(() => import("./pages/MetamaskGuide/MetamaskGuidePage.js"));
const ManageBudgetPage = lazy(() => import("./pages/ManageBudget/ManageBudgetPage.js"));
const ShowAuctionPage = lazy(() => import("./pages/ShowAuction/ShowAuctionPage.js"));

const AppLoadingFallback = ({
  copy = "Preparing the workspace",
  status = "Loading app modules",
}) => (
  <>
    <style>
      {`
        .app-loading-shell {
          min-height: 100vh;
          min-height: 100dvh;
          display: grid;
          place-items: center;
          background: #f5d762;
          color: #07105c;
          font-family: Arial, sans-serif;
        }
        .app-loading-panel {
          width: min(420px, calc(100vw - 48px));
          padding: 28px;
          border: 1px solid rgba(16, 48, 144, 0.14);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.88);
          box-shadow: 0 18px 45px rgba(16, 48, 144, 0.12);
        }
        .app-loading-brand {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 18px;
        }
        .app-loading-mark {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          background: #103090;
          color: #ffffff;
          box-shadow: 0 8px 18px rgba(16, 48, 144, 0.22);
        }
        .app-loading-mark svg {
          width: 24px;
          height: 24px;
        }
        .app-loading-title {
          margin: 0;
          font-size: 18px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .app-loading-copy {
          margin: 3px 0 0;
          color: #5e638a;
          font-size: 13px;
        }
        .app-loading-bar {
          position: relative;
          height: 6px;
          overflow: hidden;
          border-radius: 999px;
          background: #e3e8fb;
        }
        .app-loading-bar::after {
          content: "";
          position: absolute;
          inset: 0;
          width: 42%;
          border-radius: inherit;
          background: #103090;
          animation: app-loading-slide 1.15s ease-in-out infinite;
        }
        .app-loading-status {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          margin-top: 12px;
          color: #5e638a;
          font-size: 12px;
        }
        @keyframes app-loading-slide {
          0% { transform: translateX(-110%); }
          55% { transform: translateX(90%); }
          100% { transform: translateX(250%); }
        }
        @media (prefers-reduced-motion: reduce), (update: slow) {
          .app-loading-bar::after {
            animation: none;
            transform: none;
            width: 100%;
          }
        }
      `}
    </style>
    <div
      className="app-loading-shell"
      role="status"
      aria-live="polite"
      aria-label="Loading Blockchain Data Market"
    >
      <div className="app-loading-panel">
        <div className="app-loading-brand">
          <div className="app-loading-mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v18" />
              <path d="M7 8h8.5a3.5 3.5 0 0 1 0 7H6" />
              <path d="M16 3v3" />
              <path d="M8 18v3" />
            </svg>
          </div>
          <div>
            <h1 className="app-loading-title">Blockchain Data Market</h1>
            <p className="app-loading-copy">{copy}</p>
          </div>
        </div>
        <div className="app-loading-bar" />
        <div className="app-loading-status">
          <span>{status}</span>
          <span>Please wait</span>
        </div>
      </div>
    </div>
  </>
);

const RequireWallet = ({ children }) => {
  const { provider, checkIfConnected } = useMetaMask();
  const location = useLocation();
  const [walletStatus, setWalletStatus] = useState("checking");

  useEffect(() => {
    let cancelled = false;
    let verificationId = 0;

    const applyAccounts = (accounts) => {
      if (cancelled) return;
      const connected = Boolean(accounts?.length);
      localStorage.setItem("notConnected", String(!connected));
      setWalletStatus(connected ? "connected" : "disconnected");
    };

    const verifyConnection = async () => {
      const currentVerificationId = verificationId + 1;
      verificationId = currentVerificationId;

      try {
        const accounts = await checkIfConnected();
        if (cancelled || currentVerificationId !== verificationId) return;
        applyAccounts(accounts);
      } catch (error) {
        if (cancelled || currentVerificationId !== verificationId) return;
        console.error("Wallet access check failed:", error);
        applyAccounts([]);
      }
    };

    const handleAccountsChanged = (accounts) => applyAccounts(accounts);
    const handleDisconnect = () => applyAccounts([]);
    const handleFocus = () => verifyConnection();
    const handleVisibility = () => {
      if (!document.hidden) {
        verifyConnection();
      }
    };

    setWalletStatus((current) =>
      current === "connected" ? current : "checking"
    );
    verifyConnection();

    provider?.on?.("accountsChanged", handleAccountsChanged);
    provider?.on?.("disconnect", handleDisconnect);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      provider?.removeListener?.("accountsChanged", handleAccountsChanged);
      provider?.removeListener?.("disconnect", handleDisconnect);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [checkIfConnected, location.pathname, provider]);

  if (walletStatus === "checking") {
    return (
      <AppLoadingFallback
        copy="Verifying your MetaMask connection"
        status="Checking wallet access"
      />
    );
  }

  if (walletStatus !== "connected") {
    return (
      <Navigate
        to="/metamask-login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return children;
};

function App() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const handleChange = (event) => setIsMobile(event.matches);

    setIsMobile(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener?.(handleChange);
    return () => mediaQuery.removeListener?.(handleChange);
  }, []);

  return (
    <MetaMaskProvider>
      {isMobile ? (
        <>
          <style>
            {`
              .mobile-not-supported {
                min-height: 100vh;
                min-height: 100dvh;
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
              @media (prefers-reduced-motion: reduce), (update: slow) {
                .icon-container {
                  animation: none;
                }
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
             {` Our blockchain auction platform requires a larger screen for the best experience. Please use a desktop or tablet.`}
            </p>         
          </div>
        </>
      ) : (
        <>
          <Suspense fallback={<AppLoadingFallback />}>
            <Routes>
              <Route
                path="/"
                element={
                  <PageSeo page="home">
                    <HomePage />
                  </PageSeo>
                }
              />
              <Route
                path="/metamask-login"
                element={
                  <PageSeo page="metamaskLogin">
                    <MetamaskTutorialPage />
                  </PageSeo>
                }
              />
              <Route
                path="/metamask-guide"
                element={
                  <PageSeo page="metamaskGuide">
                    <MetamaskGuidePage />
                  </PageSeo>
                }
              />
              <Route
                path="/open-auction"
                element={
                  <RequireWallet>
                    <PageSeo page="createAuction">
                      <NewAuctionPage />
                    </PageSeo>
                  </RequireWallet>
                }
              />
              <Route
                path="/auctions-list"
                element={
                  <RequireWallet>
                    <PageSeo page="auctionsList">
                      <AuctionsListPage />
                    </PageSeo>
                  </RequireWallet>
                }
              />
              <Route
                path="/auction/:address"
                element={
                  <RequireWallet>
                    <PageSeo page="auctionDetails">
                      <ShowAuctionPage />
                    </PageSeo>
                  </RequireWallet>
                }
              />
              <Route
                path="/manage-budget"
                element={
                  <RequireWallet>
                    <PageSeo page="admin">
                      <ManageBudgetPage />
                    </PageSeo>
                  </RequireWallet>
                }
              />
            </Routes>
          </Suspense>
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
