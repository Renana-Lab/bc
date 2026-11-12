/* global BigInt */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getWalletMode } from "./walletMode.mjs";
import { getParticipantContext, stripParticipantParams } from "./participantId.mjs";
import { claimFunds, fetchFaucetStatus, FAUCET_MESSAGES } from "./faucetClient.mjs";
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
  // A Prolific id (?PROLIFIC_PID= / ?pid=) or lab code, plus the optional study and experiment values.
  const { pid, studyId, experimentCode } = useMemo(() => {
    let storage;
    try { storage = window.sessionStorage; } catch { storage = undefined; }
    const context = getParticipantContext({ search: window.location.search, storage });
    stripParticipantParams(window); // keep the id (a faucet capability) out of the address bar, history and Referer headers
    return context;
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

  const [faucetOpen, setFaucetOpen] = useState(null); // null = unknown
  useEffect(() => {
    if (!faucetUrl || !state.address) return undefined;
    let cancelled = false;
    fetchFaucetStatus({ faucetUrl }).then((status) => { if (!cancelled) setFaucetOpen(status.open); });
    return () => { cancelled = true; };
  }, [faucetUrl, state.address]);
  const requestFunds = () => run(async () => {
    try {
      await claimFunds({ faucetUrl, pid, address: wallet.address, studyId, experimentCode, onBusy: () => setNotice("Faucet is busy, retrying...") });
    } catch (error) {
      if (error.code === "faucet_closed") setFaucetOpen(false);
      throw error; // already a friendly message
    }
    setFaucetOpen(true);
    setNotice("Test funds sent. They are in your wallet.");
    setFunded(true);
    void loadBalance();
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

  // Backup/funding progress belongs to one wallet: clear it when that wallet is forgotten
  // or the unlocked account changes (e.g. a restore). Locking the same wallet keeps it.
  const lastAddress = useRef("");
  // Layout effect: the stale check must never paint on the new screen.
  useLayoutEffect(() => {
    const reset = () => { setBackedUp(false); setFunded(false); setNotice(""); };
    if (state.exists === false) {
      lastAddress.current = "";
      reset();
    } else if (state.address) {
      if (lastAddress.current && lastAddress.current !== state.address) reset();
      lastAddress.current = state.address;
    }
  }, [state.exists, state.address]);

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
                <h3 className={styles.stepTitle}>{unlocked ? "Wallet unlocked" : state.exists ? "Unlock your wallet" : "Create your wallet"}</h3>
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
                  {unlocked ? null : <p className={styles.hint}>A small file you can restore from if this browser forgets your wallet.</p>}
                  {unlocked ? <button type="button" className={styles.button} onClick={downloadBackup}>Download encrypted backup</button> : null}
                </div>
              </li>
              <li className={stepClass(funded, unlocked && !funded)}>
                <span className={styles.num} aria-hidden="true">{funded ? "✓" : "3"}</span>
                <h3 className={styles.stepTitle}>Get test funds</h3>
                <div className={styles.stepBody}>
                  {unlocked ? <p className={styles.balance}>Balance: {balance === null ? "—" : `${balance} ${symbol}`}</p> : null}
                  {unlocked && canFund ? <button type="button" className={styles.button} onClick={requestFunds}>Request test funds</button> : null}
                  {unlocked && !canFund ? <p className={styles.hint}>To receive test funds, open the link from your study (it contains your participant id).</p> : null}
                  {unlocked && canFund && faucetOpen === false ? <p className={styles.hint} data-testid="faucet-closed-notice">{FAUCET_MESSAGES.faucet_closed}</p> : null}
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
