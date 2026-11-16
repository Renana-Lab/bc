import React, { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Layout from "../../components/Layout.js";
import { useMetaMask } from "../../Context/Context.js";
import { getWalletCopy } from "../../real_ethereum/wallets/walletCopy";

const requestedRoute = (location) =>
  typeof location.state?.from === "string" && location.state.from.startsWith("/")
    ? location.state.from
    : "/auctions-list";

// Local (embedded wallet) mode: the wallet is locked after every reload. The wallet panel
// holds the passphrase flow; this screen only explains it and returns the user to the
// requested route once the wallet is unlocked.
function WalletUnlockPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, reason } = useMetaMask();
  const copy = getWalletCopy();

  useEffect(() => {
    if (status === "connected") navigate(requestedRoute(location), { replace: true });
  }, [status, location, navigate]);

  return (
    <Layout>
      <div style={{ maxWidth: "36rem", margin: "4rem auto", padding: "0 1.5rem", textAlign: "center" }}>
        <h1>Unlock your wallet</h1>
        <p>
          Use the wallet panel on this page to unlock {copy.walletName} with your passphrase. You
          will return to where you were once it is unlocked.
        </p>
        {status === "checking" ? (
          <p role="status">Checking your wallet...</p>
        ) : (
          reason && <p role="status">{reason}</p>
        )}
      </div>
    </Layout>
  );
}

export default WalletUnlockPage;
