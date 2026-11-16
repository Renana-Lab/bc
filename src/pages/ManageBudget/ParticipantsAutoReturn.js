// "Auto-return" part of the admin Participants gas card: which participants have a pre-signed return transfer armed
// with the faucet server, what was sent back, and how long a participant may be idle before it is broadcast.
// The faucet admin password is typed here, used for one request and never kept.
import { useCallback, useState } from "react";
import { Box, Button, TableCell, TextField, Typography } from "@mui/material";
import { adminHeadCellSx } from "./AdminCard";
import { formatNative } from "../../real_ethereum/wallets/nativeBalance";
import { fetchSweeps, saveSweepIdleMinutes } from "../../real_ethereum/wallets/sweepClient.mjs";

const STATUS_LABELS = { armed: "armed", sent: "sent", stale: "stale", none: "none" };

export const autoReturnLabel = (sweep) => STATUS_LABELS[sweep?.status] || "none";

// Amount shown next to the status: what is armed now, or what has been returned so far.
export const autoReturnAmounts = (sweep) => {
  const wei = (value) => { try { return BigInt(value || "0"); } catch { return 0n; } };
  return { armedWei: sweep?.status === "armed" ? wei(sweep.armedValue) : 0n, returnedWei: wei(sweep?.returnedWei) };
};

export const useAutoReturn = ({ faucetUrl = process.env.REACT_APP_FAUCET_URL, deps = {} } = {}) => {
  const api = { fetchSweeps, saveSweepIdleMinutes, ...deps };
  const [sweeps, setSweeps] = useState({}); // lowercase address -> sweep
  const [idleMinutes, setIdleMinutes] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (action) => {
    setBusy(true);
    setMessage("");
    try { await action(); } catch (error) { setMessage(error?.message || "Request failed."); } finally { setBusy(false); }
  }, []);
  const load = (password) => run(async () => {
    const body = await api.fetchSweeps({ faucetUrl, password });
    setSweeps(Object.fromEntries(body.sweeps.map((sweep) => [String(sweep.address).toLowerCase(), sweep])));
    setIdleMinutes(Number.isInteger(body.idleMinutes) ? body.idleMinutes : null);
  });
  const save = (password, minutes) => run(async () => { setIdleMinutes(await api.saveSweepIdleMinutes({ faucetUrl, password, idleMinutes: minutes })); });
  return { sweeps, idleMinutes, message, busy, load, save, enabled: Boolean(faucetUrl) };
};

export const AutoReturnHeaders = () => (<><TableCell sx={adminHeadCellSx}>Auto-return</TableCell><TableCell sx={adminHeadCellSx}>Returned</TableCell></>);

export const AutoReturnCells = ({ sweep, symbol }) => {
  const { armedWei, returnedWei } = autoReturnAmounts(sweep);
  return (
    <>
      <TableCell sx={{ fontSize: 12 }} data-testid="auto-return-status">
        {autoReturnLabel(sweep)}{armedWei > 0n ? ` (${formatNative(armedWei)} ${symbol})` : ""}
      </TableCell>
      <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }} data-testid="auto-return-returned">{returnedWei > 0n ? `${formatNative(returnedWei)} ${symbol}` : "—"}</TableCell>
    </>
  );
};

export const AutoReturnControls = ({ state }) => {
  const [password, setPassword] = useState("");
  const [minutes, setMinutes] = useState("");
  if (!state.enabled) return null;
  const withPassword = (action) => { const pw = password; setPassword(""); return action(pw); };
  const idle = minutes !== "" ? minutes : state.idleMinutes ?? "";
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center", mt: 2 }} data-testid="auto-return-controls">
      <Typography variant="body2" color="text.secondary">Auto-return of leftover funds to the lab address:</Typography>
      <TextField size="small" type="password" autoComplete="new-password" label="Faucet admin password" value={password} onChange={(e) => setPassword(e.target.value)} inputProps={{ "aria-label": "Auto-return admin password" }} />
      <Button size="small" variant="outlined" disabled={!password || state.busy} onClick={() => withPassword(state.load)}>Load auto-return</Button>
      <TextField size="small" label="Idle minutes (15-1440)" value={idle} onChange={(e) => setMinutes(e.target.value)} inputProps={{ "aria-label": "Idle minutes" }} sx={{ width: 170 }} />
      <Button size="small" variant="outlined" disabled={!password || state.busy || !/^\d+$/.test(String(idle))} onClick={() => withPassword((pw) => state.save(pw, Number(idle)))}>Save idle time</Button>
      {state.message ? <Typography color="error" variant="body2">{state.message}</Typography> : null}
    </Box>
  );
};
