import React, { useCallback, useEffect, useState } from "react";
import { fetchFaucetStatus, setFaucetState } from "../../real_ethereum/wallets/faucetClient.mjs";

// Hidden admin page (/admin/faucet, not linked anywhere): lets lab admins open and close the test-funds
// faucet from the website. The password lives only in this component's state for the duration of one request;
// it is never written to localStorage, sessionStorage, the URL or the console.

const card = { maxWidth: 420, margin: "64px auto", padding: 20, border: "1px solid #ccc", borderRadius: 8, font: "14px/1.5 system-ui, sans-serif", background: "#fff", color: "#111" };

const describe = (status) => {
  if (status.open === null) return "Unknown (could not read the status)";
  const when = status.updatedAt ? ` since ${new Date(status.updatedAt).toLocaleString()}` : "";
  return `${status.open ? "Open" : "Closed"}${when}`;
};

const FaucetAdminPage = ({ faucetUrl = process.env.REACT_APP_FAUCET_URL, fetchImpl } = {}) => {
  const [status, setStatus] = useState({ open: null, updatedAt: null, loaded: false });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const next = await fetchFaucetStatus({ faucetUrl, fetchImpl });
    setStatus({ ...next, loaded: true });
  }, [faucetUrl, fetchImpl]);

  useEffect(() => {
    refresh();
    // Keep this page out of search results.
    const meta = Object.assign(document.createElement("meta"), { name: "robots", content: "noindex,nofollow" });
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [refresh]);

  const target = status.open !== true; // the action the button performs: open when closed/unknown, close when open
  const submit = async (event) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await setFaucetState({ faucetUrl, open: target, password, fetchImpl });
      setMessage(target ? "The faucet is now open." : "The faucet is now closed.");
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setPassword(""); // never keep the password after the request
      setBusy(false);
    }
  };

  return (
    <main style={card} data-testid="faucet-admin">
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>Faucet admin</h1>
      {faucetUrl ? null : <p role="alert">The faucet is not configured for this build.</p>}
      <p>Status: <strong data-testid="faucet-status">{status.loaded ? describe(status) : "Loading..."}</strong>{" "}
        <button type="button" onClick={refresh}>Refresh</button></p>
      <form onSubmit={submit} autoComplete="off">
        <label htmlFor="faucet-admin-password">Admin password</label>
        <br />
        <input id="faucet-admin-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} style={{ width: "100%", margin: "4px 0 12px" }} />
        <button type="submit" disabled={!faucetUrl || !password || busy}>{target ? "Open faucet" : "Close faucet"}</button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </main>
  );
};

export default FaucetAdminPage;
