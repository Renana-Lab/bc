/* global BigInt */
import React, { useEffect, useMemo, useState } from "react";
import { getWalletMode } from "./walletMode.mjs";
import { getParticipantId } from "./participantId.mjs";
import { setModeProvider } from "./modeProvider";
import { createIndexedDbStorage, createLocalProvider, createLocalWallet } from "./localWallet.mjs";
import { getTargetNetwork } from "../sapphireNetworks";
import { clearConfidentialSessions } from "../confidentialData";
import styles from "./WalletModePanel.module.scss";

// Embedded-wallet UI, mounted only when REACT_APP_WALLET_MODE is local.
// MetaMask mode renders nothing and keeps the extension flow unchanged.

const formatBalance = (wei) => {
  const unit = 10n ** 18n;
  return `${wei / unit}.${String((wei % unit) / 10n ** 14n).padStart(4, "0")}`;
};

const LocalWalletPanel = () => {
  const network = getTargetNetwork();
  const wallet = useMemo(() => createLocalWallet({ storage: createIndexedDbStorage() }), []);
  const provider = useMemo(() => createLocalProvider({ wallet, network }), [wallet, network]);
  const [state, setState] = useState({ exists: null, address: "" });
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(true);
  const [backedUp, setBackedUp] = useState(false);
  const [funded, setFunded] = useState(false);
  const [balance, setBalance] = useState(null);
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

  // Informational only: a failed read just shows a dash.
  const loadBalance = async () => {
    try {
      const hex = await provider.request({ method: "eth_getBalance", params: [wallet.address, "latest"] });
      setBalance(formatBalance(BigInt(hex)));
    } catch {
      setBalance(null);
    }
  };

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
        setNotice("Test funds sent. They are in your wallet.");
        setFunded(true);
        void loadBalance();
        return;
      }
      if ([400, 403, 422, 503].includes(response.status) || body.error === "rate_limited") {
        throw new Error(friendly[body.error] || "Faucet request refused.");
      }
      setNotice("Faucet is busy, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    throw new Error("The faucet is busy. Try again in a minute.");
  });

  const refresh = async () => setState({ exists: await wallet.exists(), address: wallet.address });
  useEffect(() => {
    setModeProvider(provider, async () => wallet.isUnlocked());
    refresh().catch(() => setMessage("Browser storage is unavailable; the local wallet cannot be used."));
    return wallet.subscribe(() => void refresh().catch(() => {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh only reads the stable wallet object
  }, [wallet, provider]);
  useEffect(() => {
    if (state.address) void loadBalance();
    else setBalance(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the unlocked address changes
  }, [state.address]);

  const run = async (action) => {
    setMessage("");
    setNotice("");
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
    setBackedUp(true);
  };

  const unlocked = Boolean(state.address);
  const symbol = network.nativeCurrency?.symbol || "ROSE";
  const canFund = Boolean(pid && faucetUrl);
  const stepClass = (done, active) => `${styles.step} ${done ? styles.stepDone : ""} ${active ? styles.stepActive : ""}`;

  return (
    <div className={styles.panel} data-testid="local-wallet-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>Your wallet</h2>
        <button type="button" className={`${styles.button} ${styles.secondary}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <>
          {pid ? <p className={styles.badge}>Participant code: {`${pid.slice(0, 4)}…${pid.slice(-2)}`}</p> : null}
          <p className={styles.tip}>
            Do not clear this site&apos;s data (cookies / storage) while you take part: your wallet key lives in this browser.
            Step 2 gives you a safety backup, just in case.
          </p>
          {state.exists === null ? null : (
            <ol className={styles.steps}>
              <li className={stepClass(unlocked, !unlocked)}>
                <span className={styles.num} aria-hidden="true">{unlocked ? "✓" : "1"}</span>
                <h3 className={styles.stepTitle}>{state.exists ? "Unlock your wallet" : "Create your wallet"}</h3>
                <div className={styles.stepBody}>
                  {unlocked ? (
                    <p className={styles.address}>Unlocked: {state.address}</p>
                  ) : (
                    <>
                      <p className={styles.hint}>
                        {state.exists
                          ? "Enter your passphrase to unlock."
                          : "Choose a passphrase (12+ characters). The key stays encrypted in this browser only."}
                      </p>
                      <input className={styles.input} type="password" autoComplete="off" value={passphrase}
                        aria-label="Passphrase" onChange={(event) => setPassphrase(event.target.value)} placeholder="Passphrase (12+ chars)" />
                      <button type="button" className={styles.button}
                        onClick={() => run(() => (state.exists ? wallet.unlock(passphrase) : wallet.create(passphrase)))}>
                        {state.exists ? "Unlock" : "Create"}
                      </button>
                      {state.exists ? null : (
                        <label className={styles.restore}>
                          Already have a backup? Restore it (uses the passphrase above):{" "}
                          <input type="file" accept="application/json" data-testid="local-wallet-restore"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) run(async () => wallet.importEncryptedBackup(await file.text(), passphrase));
                            }} />
                        </label>
                      )}
                    </>
                  )}
                </div>
              </li>
              <li className={stepClass(backedUp, unlocked && !backedUp)}>
                <span className={styles.num} aria-hidden="true">{backedUp ? "✓" : "2"}</span>
                <h3 className={styles.stepTitle}>Save an encrypted backup</h3>
                <div className={styles.stepBody}>
                  <p className={styles.hint}>A small file you can restore from if this browser forgets your wallet.</p>
                  {unlocked ? <button type="button" className={styles.button} onClick={downloadBackup}>Download encrypted backup</button> : null}
                </div>
              </li>
              <li className={stepClass(funded, unlocked && backedUp && !funded)}>
                <span className={styles.num} aria-hidden="true">{funded ? "✓" : "3"}</span>
                <h3 className={styles.stepTitle}>Get test funds</h3>
                <div className={styles.stepBody}>
                  {unlocked ? <p className={styles.balance}>Balance: {balance === null ? "—" : `${balance} ${symbol}`}</p> : null}
                  {unlocked && canFund ? <button type="button" className={styles.button} onClick={requestFunds}>Request test funds</button> : null}
                  {unlocked && !canFund ? <p className={styles.hint}>Test funds need a participant link from the experimenter.</p> : null}
                </div>
              </li>
            </ol>
          )}
          {unlocked ? (
            <div className={styles.footer}>
              <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => { wallet.lock(); clearConfidentialSessions(); }}>Lock</button>
              <button type="button" className={`${styles.button} ${styles.secondary}`}
                onClick={() => window.confirm("Forget this wallet? Without a backup the key is lost forever.") && run(() => wallet.forget())}>Forget</button>
            </div>
          ) : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {message ? <p className={styles.error} role="alert">{message}</p> : null}
        </>
      ) : null}
    </div>
  );
};

const WalletModePanel = () => (getWalletMode() === "local" ? <LocalWalletPanel /> : null);

export default WalletModePanel;
