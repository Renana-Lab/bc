import React from "react";
import { AdminWalletRestore } from "../../real_ethereum/wallets/AdminWalletPanel";
import { getWalletMode } from "../../real_ethereum/wallets/walletMode.mjs";

// Hidden route (/admin/wallet, not linked anywhere). In local wallet mode every browser starts with its own
// silent wallet; an admin restores the allowlisted admin key here from a passphrase-encrypted backup. Once the
// restored address is on REACT_APP_ADMIN_ADDRESSES the admin wallet panel appears. Nothing here is shown to
// participants unless they type the address, and restoring needs a backup file and its passphrase.
const AdminWalletPage = () => (
  <main style={{ maxWidth: 420, margin: "64px auto", padding: 20, font: "14px/1.5 system-ui, sans-serif" }} data-testid="admin-wallet-page">
    <meta name="robots" content="noindex,nofollow" />
    <h1 style={{ fontSize: 20 }}>Admin wallet</h1>
    {getWalletMode() === "local" ? <AdminWalletRestore onRestored={() => window.location.assign("/manage-budget")} /> : <p>The admin wallet is managed in MetaMask for this build.</p>}
  </main>
);

export default AdminWalletPage;
