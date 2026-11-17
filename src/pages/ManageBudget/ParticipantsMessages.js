// "Send message" part of the admin Participants gas card: a dialog to write to one participant (or all of them) and to
// review what was sent and whether it was read. The faucet admin password is asked for once per session
// (faucetSessionPassword.js); with a session password the dialog has no password field.
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from "@mui/material";
import { fetchAdminMessages, MAX_MESSAGE_CHARS, sendAdminMessage } from "../../real_ethereum/wallets/inboxClient.mjs";
import { useFaucetSessionPassword } from "./faucetSessionPassword";
import { INBOX_POLL_SECONDS } from "../../real_ethereum/wallets/AdminMessageHost";

const defaultApi = { fetchAdminMessages, sendAdminMessage };
const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ""; } };

// Newest first: one entry per message, with its read status.
export const historyEntries = ({ data, pidHash }) => {
  if (!data) return [];
  const entries = pidHash
    ? [
      ...(data.participants.find((participant) => participant.pidHash === pidHash)?.messages || []).map((message) => ({ ...message, status: message.readAt ? `read ${when(message.readAt)}` : "unread" })),
      ...data.broadcasts.map((message) => ({ ...message, status: message.read ? "read (sent to all)" : "unread (sent to all)" })),
    ]
    : data.broadcasts.map((message) => ({ ...message, status: `read by ${message.readCount ?? 0}` }));
  return entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
};

// target: { pidHash, label, resolvePidHash?(password) } for one participant, or { all: true }.
// resolvePidHash looks the pid hash up when it was not loaded yet (the auto-return list has it).
export const SendMessageDialog = ({ target, faucetUrl = process.env.REACT_APP_FAUCET_URL, api: apiOverride, onClose }) => {
  const api = { ...defaultApi, ...apiOverride };
  const session = useFaucetSessionPassword();
  const [password, setPassword] = useState("");
  const [body, setBody] = useState("");
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState({ text: "", error: false });
  const pidRef = useRef(target.all ? undefined : target.pidHash);
  const pidHash = pidRef.current;

  const run = useCallback(async (action) => {
    setBusy(true);
    try { return await action(); } catch (error) { setNotice({ text: error?.message || "Request failed.", error: true }); return undefined; } finally { setBusy(false); }
  }, []);
  const ensurePid = async (pw) => {
    if (target.all || pidRef.current) return pidRef.current;
    const resolved = await target.resolvePidHash?.(pw);
    if (!resolved) throw new Error("This participant is not known to the faucet yet.");
    pidRef.current = resolved;
    return resolved;
  };
  const fetchHistory = (pw) => ensurePid(pw).then((pid) => api.fetchAdminMessages({ faucetUrl, password: pw, pidHash: pid }));
  const load = () => run(() => session.run(password, async (pw) => {
    setData(await fetchHistory(pw));
    setNotice({ text: "", error: false });
    setPassword("");
  }));
  const send = () => run(() => session.run(password, async (pw) => {
    const pid = await ensurePid(pw);
    await api.sendAdminMessage({ faucetUrl, password: pw, pidHash: pid, all: Boolean(target.all), body: body.trim() });
    setBody("");
    setPassword("");
    setNotice({ text: target.all ? "Message sent to all participants." : "Message sent.", error: false });
    setData(await api.fetchAdminMessages({ faucetUrl, password: pw, pidHash: pid }).catch(() => data));
  }));

  // With a session password the history loads by itself when the dialog opens.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || !session.hasPassword) return;
    autoLoaded.current = true;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.hasPassword]);

  const entries = historyEntries({ data, pidHash });
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" data-testid="send-message-dialog">
      <DialogTitle>{target.all ? "Message all participants" : `Send message to ${target.label || "participant"}`}</DialogTitle>
      <DialogContent>
        {target.all ? <Typography variant="body2" color="text.secondary">{`Shown once to every participant who has been funded, the next time their page checks for messages (within about ${INBOX_POLL_SECONDS} seconds).`}</Typography> : null}
        {session.hasPassword ? null : (
          <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1 }}>
            <TextField size="small" type="password" autoComplete="new-password" label="Faucet admin password" value={password} onChange={(e) => setPassword(e.target.value)} inputProps={{ "aria-label": "Message admin password" }} />
            <Button size="small" variant="outlined" disabled={!password || busy} onClick={load}>Load history</Button>
          </Box>
        )}
        <TextField label="Message" value={body} onChange={(e) => setBody(e.target.value)} fullWidth multiline minRows={3} margin="dense"
          inputProps={{ maxLength: MAX_MESSAGE_CHARS, "aria-label": "Message text" }} helperText={`${body.length}/${MAX_MESSAGE_CHARS}`} />
        {notice.text ? <Typography color={notice.error ? "error" : "success.main"} variant="body2" role={notice.error ? "alert" : "status"}>{notice.text}</Typography> : null}
        {entries.length ? (
          <Box sx={{ mt: 1.5 }} data-testid="message-history">
            <strong>History</strong>
            {entries.map((entry) => (
              <div key={entry.id} style={{ borderTop: "1px solid #ddd", padding: "6px 0" }} data-testid="message-history-entry">
                <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.body}</div>
                <small>{when(entry.createdAt)} - {entry.status}</small>
              </div>
            ))}
          </Box>
        ) : data ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No messages sent yet.</Typography> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={(!password && !session.hasPassword) || !body.trim() || busy} onClick={send}>Send</Button>
      </DialogActions>
    </Dialog>
  );
};
