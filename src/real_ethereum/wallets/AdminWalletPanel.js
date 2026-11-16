import React, { useCallback, useEffect, useState } from "react";
import { claimFunds } from "./faucetClient.mjs";
import { formatNative } from "./nativeBalance";
import { restoreAdminBackup } from "./adminSlot";
import styles from "./WalletModePanel.module.scss";

// Everything wallet-related that only admins may see: address, TEST balance, passphrase-encrypted backup,
// "Request test funds" and (for a first-time admin browser) restoring the admin key from a backup.
// Participants never get this component (see WalletModePanel).

const downloadJson = (text, filename) => {
  const blob = new Blob([text], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
};

export const AdminWalletRestore = ({ onRestored, restore: restoreImpl = restoreAdminBackup, confirm = (text) => window.confirm(text) }) => {
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState("");
  const restore = async (file) => {
    setMessage("");
    try {
      const result = await restoreImpl({
        json: await file.text(), passphrase,
        confirmReplace: () => confirm("An admin wallet already exists in this browser. Replace it with the backup?"),
      });
      if (!result.ok) { setMessage(result.message); return; }
      setPassphrase("");
      setMessage(`Restored ${result.account}.`);
      onRestored?.(result.account);
    } catch (error) {
      setMessage(error.message);
    }
  };
  return (
    <div data-testid="admin-wallet-restore">
      <p className={styles.hint}>Restore the admin wallet from a passphrase-encrypted backup into this browser&apos;s separate admin slot (the participant wallet is not touched).</p>
      <input className={styles.input} type="password" autoComplete="off" aria-label="Backup passphrase" value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)} placeholder="Backup passphrase" />
      <input type="file" accept="application/json" data-testid="admin-wallet-restore-file"
        onChange={(event) => { const file = event.target.files?.[0]; if (file) restore(file); }} />
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
    </div>
  );
};

const AdminWalletPanel = ({ wallet, provider, address, symbol = "TEST", faucetUrl, claimContext }) => {
  const [open, setOpen] = useState(true);
  const [balance, setBalance] = useState(null);
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const loadBalance = useCallback(async () => {
    try {
      setBalance(formatNative(BigInt(await provider.request({ method: "eth_getBalance", params: [address, "latest"] }))));
    } catch {
      setBalance(null);
    }
  }, [provider, address]);
  useEffect(() => { if (address) void loadBalance(); }, [address, loadBalance]);

  const backup = async () => {
    setMessage("");
    try {
      downloadJson(await wallet.exportBackup(passphrase), "admin-wallet-encrypted-backup.json");
      setPassphrase("");
      setNotice("Backup downloaded. Keep the passphrase: it cannot be recovered.");
    } catch (error) {
      setMessage(error.message);
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };
  const requestFunds = async () => {
    setMessage(""); setNotice("");
    try {
      await claimFunds({ faucetUrl, address, ...claimContext });
      setNotice("Test funds sent.");
      void loadBalance();
    } catch (error) {
      setMessage(error.message);
    }
  };
  const pid = claimContext?.pid;

  return (
    <div className={styles.panel} data-testid="admin-wallet-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>Admin wallet</h2>
        <button type="button" className={`${styles.button} ${styles.secondary}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <>
          <p className={styles.address} data-testid="admin-wallet-address">{address}</p>
          <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={copy}>{copied ? "Copied" : "Copy address"}</button>
          <p className={styles.balance} data-testid="admin-wallet-balance">{symbol} balance: {balance === null ? "—" : balance}</p>
          <p className={styles.hint}>Encrypted backup (passphrase, 12+ characters):</p>
          <input className={styles.input} type="password" autoComplete="off" aria-label="Backup passphrase" value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)} placeholder="Passphrase (12+ chars)" />
          <button type="button" className={styles.button} onClick={backup}>Download encrypted backup</button>
          {faucetUrl && pid ? <button type="button" className={styles.button} onClick={requestFunds}>Request test funds</button> : null}
          <AdminWalletRestore onRestored={() => window.location.reload()} />
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {message ? <p className={styles.error} role="alert">{message}</p> : null}
        </>
      ) : null}
    </div>
  );
};

export default AdminWalletPanel;
