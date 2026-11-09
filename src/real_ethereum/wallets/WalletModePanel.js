import React, { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { getWalletMode } from "./walletMode.mjs";
import { setModeProvider } from "./modeProvider";
import { createIndexedDbStorage, createLocalProvider, createLocalWallet } from "./localWallet.mjs";
import { getTargetNetwork } from "../sapphireNetworks";
import { clearConfidentialSessions } from "../confidentialData";

// Embedded-wallet UI, mounted only when REACT_APP_WALLET_MODE is privy or local.
// MetaMask mode renders nothing and keeps the extension flow unchanged.
const PrivyBridge = lazy(() => import("./PrivyBridge"));

const box = {
  position: "fixed", right: 12, bottom: 12, zIndex: 2000, maxWidth: 340, padding: 12, borderRadius: 8,
  background: "#fff", color: "#111", border: "1px solid #ccc", font: "13px/1.4 system-ui, sans-serif",
};

const LocalWalletPanel = () => {
  const network = getTargetNetwork();
  const wallet = useMemo(() => createLocalWallet({ storage: createIndexedDbStorage() }), []);
  const provider = useMemo(() => createLocalProvider({ wallet, network }), [wallet, network]);
  const [state, setState] = useState({ exists: null, address: "" });
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState("");

  const refresh = async () => setState({ exists: await wallet.exists(), address: wallet.address });
  useEffect(() => {
    setModeProvider(provider, async () => wallet.isUnlocked());
    void refresh();
    return wallet.subscribe(() => void refresh());
  }, [wallet, provider]);

  const run = async (action) => {
    setMessage("");
    try { await action(); setPassphrase(""); } catch (error) { setMessage(error.message); }
    await refresh();
  };
  const downloadBackup = async () => {
    const blob = new Blob([await wallet.exportEncryptedBackup()], { type: "application/json" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "local-wallet-encrypted-backup.json" });
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div style={box} data-testid="local-wallet-panel">
      <strong>Local wallet (spike)</strong>
      {state.exists === null ? null : state.address ? (
        <>
          <div style={{ wordBreak: "break-all" }}>Unlocked: {state.address}</div>
          <button onClick={() => { wallet.lock(); clearConfidentialSessions(); }}>Lock</button>{" "}
          <button onClick={downloadBackup}>Download encrypted backup</button>{" "}
          <button onClick={() => window.confirm("Forget this wallet? Without a backup the key is lost forever.") && run(() => wallet.forget())}>Forget</button>
        </>
      ) : (
        <>
          <div>{state.exists ? "Enter your passphrase to unlock." : "Create a wallet. The key stays encrypted in this browser only. Clearing site data deletes it, so download the encrypted backup."}</div>
          <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Passphrase (8+ chars)" />{" "}
          <button onClick={() => run(() => (state.exists ? wallet.unlock(passphrase) : wallet.create(passphrase)))}>{state.exists ? "Unlock" : "Create"}</button>
        </>
      )}
      {message ? <div role="alert">{message}</div> : null}
    </div>
  );
};

const WalletModePanel = () => {
  const mode = getWalletMode();
  if (mode === "local") return <LocalWalletPanel />;
  if (mode === "privy") {
    return (
      <Suspense fallback={null}>
        <PrivyBridge boxStyle={box} />
      </Suspense>
    );
  }
  return null;
};

export default WalletModePanel;
