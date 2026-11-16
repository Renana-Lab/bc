import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { getWalletScopeOverride, isInvisibleWalletMode } from "./walletMode.mjs";
import { fetchSweepConfig, pidHashFor } from "./sweepClient.mjs";
import { ackInbox, fetchInbox } from "./inboxClient.mjs";

// Messages from the administrator. Draws nothing until one arrives, then a blocking popup, one message at a time.
//  * Polls the faucet server every 5 s while the tab is visible, and right away when the participant returns to the tab.
//  * "Got it" tells the server (signed with the wallet) so the message is not shown again; ids are also remembered
//    for this page load, so a message never opens twice even if the acknowledgement is still on its way.
// Same gating as AutoSweepHost: only for the invisible local wallet of a participant, never in MetaMask mode,
// never with the admin override or the admin key slot, never for an admin address.
export const POLL_MS = 5_000;
export const INBOX_POLL_SECONDS = POLL_MS / 1000; // quoted in the admin message dialog
const CONFIG_RETRY_MS = 30_000;
const CONFIG_ATTEMPTS = 4;

const AdminMessageHost = ({ wallet, address, faucetUrl, strictPid, openPid, isAdmin = false, pollMs = POLL_MS }) => {
  const enabled = Boolean(wallet && address && faucetUrl && (strictPid || openPid) && !isAdmin && isInvisibleWalletMode() && getWalletScopeOverride() !== "admin");
  const [queue, setQueue] = useState([]);
  const ackRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    let retryTimer = null;
    let session = null; // { pidHash, offset } once the server has told us the pid mode and its clock
    let busy = false;
    const seen = new Set(); // every id shown (or being shown) in this page load
    const unacked = new Set(); // ids whose acknowledgement did not reach the server yet
    const signMessage = (message) => wallet.signMessage(message);
    const now = () => Date.now() + (session?.offset || 0);
    const send = (ids) => ackInbox({ faucetUrl, address, pidHash: session.pidHash, ids, signMessage, now });

    const poll = async () => {
      if (!session || busy || cancelled) return;
      busy = true;
      try {
        for (const id of [...unacked]) { if (await send([id])) unacked.delete(id); }
        const result = await fetchInbox({ faucetUrl, address, pidHash: session.pidHash, signMessage, now });
        if (cancelled || !result.ok) return;
        if (result.serverTime !== null) session.offset = result.serverTime - Date.now();
        const fresh = result.messages.filter((message) => !seen.has(message.id));
        fresh.forEach((message) => seen.add(message.id));
        if (fresh.length) setQueue((current) => [...current, ...fresh]);
      } catch {
        // silent: the next poll tries again
      } finally {
        busy = false;
      }
    };
    ackRef.current = async (id) => {
      if (!session) return;
      if (!(await send([id]))) unacked.add(id);
    };
    const onVisible = () => { if (!document.hidden) poll(); };

    const start = async (attempt) => {
      const config = await fetchSweepConfig({ faucetUrl });
      if (cancelled) return;
      if (!config) {
        if (attempt + 1 < CONFIG_ATTEMPTS) retryTimer = setTimeout(() => start(attempt + 1), CONFIG_RETRY_MS);
        return;
      }
      const pidHash = pidHashFor({ strictPid, openPid, pidMode: config.pidMode });
      if (!pidHash) return;
      // Signature timestamps use the server's clock (a participant's clock may be minutes off).
      session = { pidHash, offset: Number.isFinite(config.serverTime) ? config.serverTime - Date.now() : 0 };
      poll();
      timer = setInterval(() => { if (!document.hidden) poll(); }, pollMs);
      document.addEventListener("visibilitychange", onVisible);
    };
    start(0);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ackRef.current = null;
    };
  }, [enabled, address, faucetUrl, strictPid, openPid, wallet, pollMs]);

  const current = queue[0];
  if (!enabled || !current) return null;
  const gotIt = () => {
    setQueue((items) => items.slice(1));
    ackRef.current?.(current.id);
  };
  // Blocking: no backdrop or Escape dismissal, only the button. The text is rendered as plain text (React escapes it).
  return (
    <Dialog open disableEscapeKeyDown onClose={() => {}} aria-labelledby="admin-message-title" data-testid="admin-message-dialog">
      <DialogTitle id="admin-message-title">Message from the administrator</DialogTitle>
      <DialogContent>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "1.3rem", lineHeight: 1.5 }} data-testid="admin-message-body">{current.body}</div>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" autoFocus onClick={gotIt}>Got it</Button>
      </DialogActions>
    </Dialog>
  );
};

export default AdminMessageHost;
