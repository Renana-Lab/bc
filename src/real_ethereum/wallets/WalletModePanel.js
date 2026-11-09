import React, { useEffect, useMemo, useState } from "react";
import { getWalletMode } from "./walletMode.mjs";
import { getParticipantId } from "./participantId.mjs";
import { setModeProvider } from "./modeProvider";
import { createIndexedDbStorage, createLocalProvider, createLocalWallet } from "./localWallet.mjs";
import { getTargetNetwork } from "../sapphireNetworks";
import { clearConfidentialSessions } from "../confidentialData";

// Embedded-wallet UI, mounted only when REACT_APP_WALLET_MODE is local.
// MetaMask mode renders nothing and keeps the extension flow unchanged.

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
  const pid = useMemo(() => {
    let storage;
    try { storage = window.sessionStorage; } catch { storage = undefined; }
    const code = getParticipantId({ search: window.location.search, storage });
    // The code is a faucet capability: keep it out of the address bar, history and Referer headers.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("pid")) {
        url.searchParams.delete("pid");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // not fatal
    }
    return code;
  }, []);
  const faucetUrl = process.env.REACT_APP_FAUCET_URL;
  const requestFunds = () => run(async () => {
    const friendly = {
      not_eligible: "This participant code cannot receive funds (unknown or already used).",
      faucet_empty: "The faucet is empty. Tell the experimenter.",
      transfer_failed: "The transfer failed. Use a normal wallet address.",
      rate_limited: "Too many requests. Wait a few minutes.",
    };
    // 429 (Lambda throttling), 202 (payment still confirming), 409 (in progress) and 5xx are retried.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${faucetUrl}/claim`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid, address: wallet.address }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 200 && (body.status === "paid" || body.status === "already_paid")) {
        setMessage("Test funds sent. They are in your wallet.");
        return;
      }
      if ([400, 403, 422, 503].includes(response.status) || body.error === "rate_limited") {
        throw new Error(friendly[body.error] || "Faucet request refused.");
      }
      setMessage("Faucet is busy, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    throw new Error("The faucet is busy. Try again in a minute.");
  });

  const refresh = async () => setState({ exists: await wallet.exists(), address: wallet.address });
  useEffect(() => {
    setModeProvider(provider, async () => wallet.isUnlocked());
    refresh().catch(() => setMessage("Browser storage is unavailable; the local wallet cannot be used."));
    return wallet.subscribe(() => void refresh().catch(() => {}));
  }, [wallet, provider]);

  const run = async (action) => {
    setMessage("");
    try { await action(); setPassphrase(""); } catch (error) { setMessage(error.message); }
    await refresh();
  };
  const downloadBackup = async () => {
    const blob = new Blob([await wallet.exportEncryptedBackup()], { type: "application/json" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "local-wallet-encrypted-backup.json" });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };

  return (
    <div style={box} data-testid="local-wallet-panel">
      <strong>Local wallet (spike)</strong>
      {pid ? <div>Participant code: {`${pid.slice(0, 4)}…${pid.slice(-2)}`}</div> : null}
      <div style={{ color: "#8a1c1c" }}>
        Do not clear this site&apos;s data (cookies / storage) during the session: the wallet key lives there.
        Download the encrypted backup first; you can restore it below.
      </div>
      {state.exists === null ? null : state.address ? (
        <>
          <div style={{ wordBreak: "break-all" }}>Unlocked: {state.address}</div>
          <button onClick={() => { wallet.lock(); clearConfidentialSessions(); }}>Lock</button>{" "}
          <button onClick={downloadBackup}>Download encrypted backup</button>{" "}
          {pid && faucetUrl ? <button onClick={requestFunds}>Request test funds</button> : null}{" "}
          <button onClick={() => window.confirm("Forget this wallet? Without a backup the key is lost forever.") && run(() => wallet.forget())}>Forget</button>
        </>
      ) : (
        <>
          <div>{state.exists ? "Enter your passphrase to unlock." : "Create a wallet. The key stays encrypted in this browser only. Clearing site data deletes it, so download the encrypted backup."}</div>
          <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Passphrase (12+ chars)" />{" "}
          <button onClick={() => run(() => (state.exists ? wallet.unlock(passphrase) : wallet.create(passphrase)))}>{state.exists ? "Unlock" : "Create"}</button>
          {state.exists ? null : (
            <div>
              Restore from an encrypted backup (uses the passphrase above):{" "}
              <input type="file" accept="application/json" data-testid="local-wallet-restore"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) run(async () => wallet.importEncryptedBackup(await file.text(), passphrase));
                }} />
            </div>
          )}
        </>
      )}
      {message ? <div role="alert">{message}</div> : null}
    </div>
  );
};

const WalletModePanel = () => (getWalletMode() === "local" ? <LocalWalletPanel /> : null);

export default WalletModePanel;
