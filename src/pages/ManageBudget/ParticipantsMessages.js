// "Send message" part of the admin Participants gas card: a dialog to write to one participant (or all of them) and to
// review what was sent and whether it was read. The faucet admin password is typed in the dialog, used for each
// request and dropped when the dialog closes.
import { useCallback, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from "@mui/material";
import { fetchAdminMessages, MAX_MESSAGE_CHARS, sendAdminMessage } from "../../real_ethereum/wallets/inboxClient.mjs";

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

// target: { pidHash, label } for one participant, or { all: true }.
export const SendMessageDialog = ({ target, faucetUrl = process.env.REACT_APP_FAUCET_URL, api: apiOverride, onClose }) => {
  const api = { ...defaultApi, ...apiOverride };
  const [password, setPassword] = useState("");
  const [body, setBody] = useState("");
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState({ text: "", error: false });
  const pidHash = target.all ? undefined : target.pidHash;

  const run = useCallback(async (action) => {
    setBusy(true);
    try { await action(); } catch (error) { setNotice({ text: error?.message || "Request failed.", error: true }); } finally { setBusy(false); }
  }, []);
  const load = () => run(async () => { setData(await api.fetchAdminMessages({ faucetUrl, password, pidHash })); setNotice({ text: "", error: false }); });
  const send = () => run(async () => {
    await api.sendAdminMessage({ faucetUrl, password, pidHash, all: Boolean(target.all), body: body.trim() });
    setBody("");
    setNotice({ text: target.all ? "Message sent to all participants." : "Message sent.", error: false });
    setData(await api.fetchAdminMessages({ faucetUrl, password, pidHash }).catch(() => data));
  });

  const entries = historyEntries({ data, pidHash });
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" data-testid="send-message-dialog">
      <DialogTitle>{target.all ? "Message all participants" : `Send message to ${target.label || "participant"}`}</DialogTitle>
      <DialogContent>
        {target.all ? <Typography variant="body2" color="text.secondary">Shown once to every participant who has been funded, the next time their page checks for messages (within about 30 seconds).</Typography> : null}
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1 }}>
          <TextField size="small" type="password" autoComplete="new-password" label="Faucet admin password" value={password} onChange={(e) => setPassword(e.target.value)} inputProps={{ "aria-label": "Message admin password" }} />
          <Button size="small" variant="outlined" disabled={!password || busy} onClick={load}>Load history</Button>
        </Box>
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
        <Button variant="contained" disabled={!password || !body.trim() || busy} onClick={send}>Send</Button>
      </DialogActions>
    </Dialog>
  );
};
