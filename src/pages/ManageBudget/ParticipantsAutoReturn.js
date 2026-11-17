// "Auto-return" part of the admin Participants gas card: which participants have a pre-signed return transfer armed
// with the faucet server, what was sent back, and how long a participant may be idle before it is broadcast.
// The signed-in admin wallet is tried first; the faucet admin password (typed once per session, see faucetSessionPassword.js) is the fallback.
import { useCallback, useState } from "react";
import { Box, Button, TableCell, TextField, Typography } from "@mui/material";
import { adminHeadCellSx } from "./AdminCard";
import { useFaucetSessionPassword } from "./faucetSessionPassword";
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
  const session = useFaucetSessionPassword();
  const [sweeps, setSweeps] = useState({}); // lowercase address -> sweep
  const [idleMinutes, setIdleMinutes] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (action) => {
    setBusy(true);
    setMessage("");
    try { return await action(); } catch (error) { setMessage(error?.message || "Request failed."); return undefined; } finally { setBusy(false); }
  }, []);
  // load(typed) uses the typed password, or the session one when nothing is typed. Resolves to the sweeps map
  // (lowercase address -> sweep) or undefined when the request failed.
  const load = (typed) => run(() => session.run(typed, async (auth) => {
    const body = await api.fetchSweeps({ faucetUrl, ...auth });
    const map = Object.fromEntries(body.sweeps.map((sweep) => [String(sweep.address).toLowerCase(), sweep]));
    setSweeps(map);
    setIdleMinutes(Number.isInteger(body.idleMinutes) ? body.idleMinutes : null);
    return map;
  }));
  const save = (typed, minutes) => run(() => session.run(typed, async (auth) => {
    setIdleMinutes(await api.saveSweepIdleMinutes({ faucetUrl, ...auth, idleMinutes: minutes }));
  }));
  return { sweeps, idleMinutes, message, busy, load, save, enabled: Boolean(faucetUrl), hasPassword: session.hasCredential, usesWallet: session.usesWallet, forget: session.forget };
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
  // Typed passwords are handed over once; a working one is remembered for the session, so the field disappears.
  const withPassword = (action) => { const pw = password; setPassword(""); return action(pw); };
  const idle = minutes !== "" ? minutes : state.idleMinutes ?? "";
  const canAct = (state.hasPassword || Boolean(password)) && !state.busy;
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center", mt: 2 }} data-testid="auto-return-controls">
      <Typography variant="body2" color="text.secondary">Auto-return of leftover funds to the lab address:</Typography>
      {state.usesWallet ? (
        <Typography variant="caption" color="text.secondary" data-testid="wallet-auth-note">Using your admin wallet.</Typography>
      ) : state.hasPassword ? (
        <Typography variant="caption" color="text.secondary" data-testid="session-password-note">
          Faucet admin password saved for this session. <Button size="small" onClick={state.forget}>Forget</Button>
        </Typography>
      ) : (
        <TextField size="small" type="password" autoComplete="new-password" label="Faucet admin password" value={password} onChange={(e) => setPassword(e.target.value)} inputProps={{ "aria-label": "Auto-return admin password" }} />
      )}
      <Button size="small" variant="outlined" disabled={!canAct} onClick={() => withPassword(state.load)}>Load auto-return</Button>
      <TextField size="small" label="Idle minutes (15-1440)" value={idle} onChange={(e) => setMinutes(e.target.value)} inputProps={{ "aria-label": "Idle minutes" }} sx={{ width: 170 }} />
      <Button size="small" variant="outlined" disabled={!canAct || !/^\d+$/.test(String(idle))} onClick={() => withPassword((pw) => state.save(pw, Number(idle)))}>Save idle time</Button>
      {state.message ? <Typography color="error" variant="body2">{state.message}</Typography> : null}
    </Box>
  );
};
