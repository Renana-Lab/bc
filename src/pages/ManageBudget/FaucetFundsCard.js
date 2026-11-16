// Faucet funds & payout limit. Shown (a) in the Admin Zone for admin wallets, with "Top up faucet", and (b) on the
// password-protected /admin/faucet page without the wallet part. Nothing here is automatic.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from "@mui/material";
import { getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import { ADMIN_GAS_RESERVE_WEI, formatNative, parseNative } from "../../real_ethereum/wallets/nativeBalance";
import { fetchFaucetAdminStatus, setFaucetMaxPayouts } from "../../real_ethereum/wallets/faucetClient.mjs";
import { useIsAdminWallet } from "../../real_ethereum/wallets/useIsAdminWallet";
import { readNativeBalances } from "./participantsGasReaders";
import { explorerAddressUrl, explorerTxUrl, readAdminBalance, sendNativeFromAdmin, waitForReceipt } from "./adminTransfer";

export const FAUCET_LOW_WEI = 5n * 10n ** 18n; // same threshold as the CloudWatch alarm
export const DEFAULT_FAUCET_TOPUP = "10";
export const FAUCET_REFRESH_MS = 60_000;

// floor(balance / payout amount), or null when either is unknown.
export const remainingPayouts = (balanceWei, payoutAmountWei) => {
  if (balanceWei === null || balanceWei === undefined || !payoutAmountWei || BigInt(payoutAmountWei) <= 0n) return null;
  return BigInt(balanceWei) / BigInt(payoutAmountWei);
};

export const payoutWarnings = ({ status, balanceWei }) => {
  const warnings = [];
  if (!status || status.maxPayouts === null || status.maxPayouts === undefined) return warnings;
  const left = status.maxPayouts - status.payoutsUsed;
  if (left < 5) warnings.push(`Only ${left} payout${left === 1 ? "" : "s"} left.`);
  if (balanceWei !== null && balanceWei !== undefined && status.payoutAmount && balanceWei < BigInt(left > 0 ? left : 0) * BigInt(status.payoutAmount)) {
    warnings.push("The faucet balance does not cover the remaining payouts.");
  }
  return warnings;
};

const cardSx = { width: "100%", mb: 3, p: { xs: 1.5, sm: 2 }, border: "1px solid #d9dff2", borderRadius: 3, background: "rgba(255,255,255,0.72)" };
const mono = { fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" };
const defaultDeps = { readBalances: readNativeBalances, fetchStatus: fetchFaucetAdminStatus, setMax: setFaucetMaxPayouts, send: sendNativeFromAdmin, waitFor: waitForReceipt, readAdminBalance };

export const FaucetFundsCardBody = ({
  faucetUrl = process.env.REACT_APP_FAUCET_URL, envAddress = process.env.REACT_APP_FAUCET_ADDRESS,
  adminAccount = "", allowTopUp = false, deps: depsOverride, fetchImpl, refreshMs = FAUCET_REFRESH_MS,
}) => {
  const deps = useMemo(() => ({ ...defaultDeps, ...depsOverride }), [depsOverride]);
  const symbol = getTargetNetwork().nativeCurrency?.symbol || "TEST";
  const [status, setStatus] = useState(null); // from the admin endpoint (needs the password)
  const [password, setPassword] = useState("");
  const [dialogPassword, setDialogPassword] = useState(""); // typed inside the Add payouts dialog
  const [balanceWei, setBalanceWei] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [addConfirm, setAddConfirm] = useState(null); // number of payouts to add
  const [customAdd, setCustomAdd] = useState("");
  const [topUpAmount, setTopUpAmount] = useState(DEFAULT_FAUCET_TOPUP);
  const [topUpConfirm, setTopUpConfirm] = useState(null); // { adminBalance, error }
  const [topUpState, setTopUpState] = useState(null); // { state, hash, error }

  const faucetAddress = status?.faucetAddress || envAddress || "";

  const loadBalance = useCallback(async () => {
    if (!faucetAddress) return;
    try {
      const balances = await deps.readBalances([faucetAddress]);
      const value = balances[faucetAddress.toLowerCase()];
      setBalanceWei(value === undefined ? null : value);
    } catch { setBalanceWei(null); }
  }, [deps, faucetAddress]);
  useEffect(() => { loadBalance(); }, [loadBalance]);
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) loadBalance(); }, refreshMs);
    return () => window.clearInterval(id);
  }, [loadBalance, refreshMs]);

  // The password never outlives one request. "Add payouts" has its own password field INSIDE its dialog, so one pass
  // (open dialog, type the password, confirm) is enough even though loading the status already spent the card's field.
  const withPassword = async (pw, clear, action) => {
    if (!pw || busy) return;
    setBusy(true); setMessage("");
    try { await action(pw); } catch (error) { setMessage(error.message); }
    finally { clear(""); setBusy(false); }
  };
  const loadStatus = () => withPassword(password, setPassword, async (pw) => setStatus(await deps.fetchStatus({ faucetUrl, password: pw, fetchImpl })));
  const closeAdd = () => { setAddConfirm(null); setDialogPassword(""); };
  const addPayouts = () => withPassword(dialogPassword, setDialogPassword, async (pw) => {
    const value = status.maxPayouts + addConfirm;
    const result = await deps.setMax({ faucetUrl, value, password: pw, fetchImpl });
    setStatus((current) => ({ ...current, maxPayouts: result.maxPayouts, payoutsUsed: result.payoutsUsed }));
    setMessage(`Payout limit is now ${result.maxPayouts}.`);
    closeAdd();
  });

  const left = status && status.maxPayouts !== null ? status.maxPayouts - status.payoutsUsed : null;
  const remaining = remainingPayouts(balanceWei, status?.payoutAmount);
  const lowBalance = balanceWei !== null && balanceWei < FAUCET_LOW_WEI;
  const warnings = payoutWarnings({ status, balanceWei });
  const customCount = /^\d+$/.test(customAdd.trim()) ? Number(customAdd.trim()) : 0;

  const topUpWei = parseNative(topUpAmount);
  const openTopUp = async () => {
    setTopUpConfirm({ adminBalance: null, error: "" });
    try { setTopUpConfirm({ adminBalance: await deps.readAdminBalance(adminAccount), error: "" }); }
    catch (error) { setTopUpConfirm({ adminBalance: null, error: error?.message || "Your balance is unavailable." }); }
  };
  const insufficient = topUpConfirm?.adminBalance != null && topUpWei ? topUpConfirm.adminBalance < topUpWei + ADMIN_GAS_RESERVE_WEI : false;
  const sendTopUp = async () => {
    setTopUpConfirm(null);
    setTopUpState({ state: "sending" });
    try {
      const hash = await deps.send(faucetAddress, topUpWei);
      setTopUpState({ state: "sent", hash });
      const ok = await deps.waitFor(hash);
      if (ok === null || ok === undefined) setTopUpState({ state: "unconfirmed", hash });
      else setTopUpState({ state: ok ? "confirmed" : "failed", hash, error: ok ? "" : "Transaction failed" });
      loadBalance();
    } catch (error) {
      setTopUpState({ state: "failed", error: error?.message || "Transaction failed" });
    }
  };

  return (
    <Box sx={cardSx} data-testid="faucet-funds-card">
      <Typography variant="h6">Faucet funds</Typography>
      {!faucetAddress ? (
        <Typography variant="body2" color="text.secondary">Faucet address unknown: set REACT_APP_FAUCET_ADDRESS or load the status with the admin password.</Typography>
      ) : (
        <>
          <Typography variant="body2" sx={mono}>{faucetAddress}</Typography>
          <Typography data-testid="faucet-balance" sx={{ mt: 1 }}>
            Balance: <strong>{balanceWei === null ? "—" : `${formatNative(balanceWei)} ${symbol}`}</strong>{" "}
            {lowBalance ? <Chip size="small" color="warning" label={`Low: below ${formatNative(FAUCET_LOW_WEI, 0)} ${symbol}`} data-testid="faucet-low-badge" /> : null}
          </Typography>
          {remaining !== null ? <Typography data-testid="faucet-remaining">Payouts the balance can still cover: {remaining.toString()}</Typography> : null}
        </>
      )}

      {faucetUrl ? (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2">Payout limit</Typography>
          {status && left !== null ? (
            <Typography data-testid="faucet-payouts">{status.payoutsUsed} of {status.maxPayouts} payouts used, {left} left</Typography>
          ) : status ? (
            <Typography variant="body2" color="text.secondary">This faucet has no payout limit (allowlist mode).</Typography>
          ) : null}
          {warnings.map((warning) => <Typography key={warning} variant="body2" sx={{ color: "#8a5a00" }} data-testid="faucet-warning">{warning}</Typography>)}
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", mt: 1 }}>
            <TextField size="small" type="password" autoComplete="new-password" label="Faucet admin password" value={password} onChange={(e) => setPassword(e.target.value)} inputProps={{ "aria-label": "Faucet admin password" }} />
            <Button size="small" variant="outlined" onClick={loadStatus} disabled={!password || busy}>{status ? "Reload status" : "Load status"}</Button>
          </Box>
          {status && left !== null ? (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", mt: 1 }}>
              <Button size="small" variant="outlined" onClick={() => setAddConfirm(10)}>+10</Button>
              <Button size="small" variant="outlined" onClick={() => setAddConfirm(50)}>+50</Button>
              <TextField size="small" label="Custom" value={customAdd} onChange={(e) => setCustomAdd(e.target.value)} inputProps={{ "aria-label": "Custom payouts" }} sx={{ width: 110 }} />
              <Button size="small" variant="outlined" disabled={!customCount} onClick={() => setAddConfirm(customCount)}>Add payouts</Button>
            </Box>
          ) : null}
          {message ? <Typography role="status" variant="body2" sx={{ mt: 1 }}>{message}</Typography> : null}
        </Box>
      ) : null}

      {allowTopUp && faucetAddress ? (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2">Top up faucet</Typography>
          <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1 }}>
            <TextField size="small" label={`Amount (${symbol})`} value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} error={topUpAmount !== "" && !topUpWei} inputProps={{ "aria-label": "Top-up amount" }} />
            <Button size="small" variant="contained" disabled={!topUpWei || topUpState?.state === "sending" || topUpState?.state === "sent"} onClick={openTopUp}>Top up faucet</Button>
          </Box>
          {topUpState ? (
            <Typography variant="body2" data-testid="faucet-topup-status" sx={{ mt: 1 }}>
              {topUpState.state === "sending" ? "Sending..." : topUpState.state === "sent" ? "Sent, waiting for confirmation..." : topUpState.state === "confirmed" ? "Confirmed." : topUpState.state === "unconfirmed" ? "Unconfirmed (check explorer)." : `Failed: ${topUpState.error}`}{" "}
              {topUpState.hash ? <a href={explorerTxUrl(topUpState.hash)} target="_blank" rel="noopener noreferrer">View transaction</a> : null}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {faucetAddress && explorerAddressUrl(faucetAddress) ? <Typography variant="caption"><a href={explorerAddressUrl(faucetAddress)} target="_blank" rel="noopener noreferrer">Faucet on the explorer</a></Typography> : null}

      <Dialog open={addConfirm !== null} onClose={closeAdd}>
        <DialogTitle>Add payouts</DialogTitle>
        <DialogContent>
          <Typography data-testid="add-confirm-text">Raise the payout limit from {status?.maxPayouts} to {status ? status.maxPayouts + (addConfirm || 0) : ""} (+{addConfirm}). The limit cannot exceed 1000.</Typography>
          <TextField size="small" fullWidth type="password" autoComplete="new-password" label="Faucet admin password" sx={{ mt: 2 }}
            value={dialogPassword} onChange={(e) => setDialogPassword(e.target.value)} inputProps={{ "aria-label": "Confirm faucet admin password" }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAdd}>Cancel</Button>
          <Button variant="contained" onClick={addPayouts} disabled={!dialogPassword || busy}>Confirm</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(topUpConfirm)} onClose={() => setTopUpConfirm(null)}>
        <DialogTitle>Confirm faucet top-up</DialogTitle>
        <DialogContent>
          <Typography data-testid="topup-confirm-text">Send {topUpAmount} {symbol} to the faucet.</Typography>
          <Typography data-testid="topup-admin-balance" sx={{ mt: 1 }}>
            Your balance: {topUpConfirm?.adminBalance == null ? "loading..." : `${formatNative(topUpConfirm.adminBalance)} ${symbol}`}
          </Typography>
          {topUpConfirm?.error ? <Typography color="error">{topUpConfirm.error}</Typography> : null}
          {insufficient ? <Typography color="error" data-testid="topup-insufficient">Your balance is not enough for this transfer plus the network fee.</Typography> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTopUpConfirm(null)}>Cancel</Button>
          <Button variant="contained" onClick={sendTopUp} disabled={insufficient || topUpConfirm?.adminBalance == null || !topUpWei}>Confirm and send</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

// Admin Zone version: admin wallets only, with the wallet top-up.
const FaucetFundsCard = (props) => {
  const { account, isAdmin } = useIsAdminWallet({ allowlist: props.allowlist });
  return isAdmin ? <FaucetFundsCardBody adminAccount={account} allowTopUp {...props} /> : null;
};

export default FaucetFundsCard;
