import React, { useState } from "react";
import { connectAdminWithMetaMask, importAdminKey, readOnChainAdminRole } from "./adminLogin";
import { getWalletMode } from "../../real_ethereum/wallets/walletMode.mjs";

// Hidden route (/admin-login), reached from the Admin Zone entry only. Participants never need it.
const defaultRedirect = (path) => window.location.assign(path);

const AdminLoginPage = ({ allowlist, findProvider, extraAdminCheck = readOnChainAdminRole, redirect = defaultRedirect, silentStorage }) => {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");

  const finish = (result) => {
    if (result.ok) redirect("/manage-budget"); // full navigation: the whole app re-reads the wallet mode
    else setMessage(result.message);
  };
  const connect = async () => {
    setBusy(true); setMessage("");
    try { finish(await connectAdminWithMetaMask({ findProvider, allowlist, extraAdminCheck })); } finally { setBusy(false); }
  };
  const importKey = async () => {
    setBusy(true); setMessage("");
    try {
      const result = await importAdminKey({ privateKey: key, allowlist, ...(silentStorage ? { silentStorage } : {}) });
      setKey("");
      finish(result);
    } catch (error) {
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  return (
    <main style={{ maxWidth: 440, margin: "64px auto", padding: 20, font: "14px/1.5 system-ui, sans-serif" }} data-testid="admin-login">
      <meta name="robots" content="noindex,nofollow" />
      <h1 style={{ fontSize: 20 }}>Admin sign-in</h1>
      {getWalletMode() === "metamask" ? <p>This build already uses MetaMask: open the Admin Zone directly.</p> : null}
      <button type="button" onClick={connect} disabled={busy}>Connect MetaMask</button>
      <hr />
      <p><strong>Import admin key</strong> (fallback)</p>
      <p role="note">Testnet keys only. Never paste a key that holds real funds. It is stored encrypted in this browser, separate from the participant wallet.</p>
      <input type="password" autoComplete="off" aria-label="Admin private key" value={key} onChange={(event) => setKey(event.target.value)} style={{ width: "100%" }} />
      <button type="button" onClick={importKey} disabled={busy || !key}>Import admin key</button>
      {message ? <p role="alert">{message}</p> : null}
    </main>
  );
};

export default AdminLoginPage;
