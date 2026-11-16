// Admin Zone card: who needs native funds ("gas") and a confirmed, sequential top-up. Admin only; never automatic.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from "@mui/material";
import { getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import { formatNative, parseNative, ADMIN_GAS_RESERVE_WEI } from "../../real_ethereum/wallets/nativeBalance";
import { useIsAdminWallet } from "../../real_ethereum/wallets/useIsAdminWallet";
import { LOCAL_BOTS_KEY } from "../../telemetry/botPresence";
import { mapBotConfig } from "./adminCardData";
import {
  DEFAULT_THRESHOLD, DEFAULT_TOPUP_AMOUNT, addressesFromEvents, REFRESH_MS, buildParticipantRows, isAddressLike, loadManualAddresses, loadSetting,
  planTopUp, runTopUps, saveManualAddresses, saveSetting, selectLowRows,
} from "./participantsGasData";
import { readBudgets, readNativeBalances, readParticipantSources } from "./participantsGasReaders";
import { explorerTxUrl, readAdminBalance, sendNativeFromAdmin, waitForReceipt } from "./adminTransfer";

const cardSx = { width: "100%", mb: 3, p: { xs: 1.5, sm: 2 }, border: "1px solid #d9dff2", borderRadius: 3, background: "rgba(255,255,255,0.72)" };
const mono = { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" };

const readLocalBots = () => {
  try { return mapBotConfig(JSON.parse(window.localStorage.getItem(LOCAL_BOTS_KEY) || "[]")); } catch { return mapBotConfig([]); }
};

const statusText = (status) => {
  if (!status) return "";
  if (status.state === "sending") return "Sending...";
  if (status.state === "sent") return "Sent, waiting for confirmation...";
  if (status.state === "confirmed") return "Confirmed";
  if (status.state === "unconfirmed") return "Unconfirmed (check explorer)";
  if (status.state === "skipped") return `Skipped: ${status.error}`;
  return `Failed: ${status.error || "error"}`;
};

const defaultDeps = {
  readSources: readParticipantSources, readBalances: readNativeBalances, readBudgets,
  send: sendNativeFromAdmin, waitFor: waitForReceipt, readAdminBalance,
};

export const ParticipantsGasCardBody = ({ adminAccount, deps: depsOverride, refreshMs = REFRESH_MS }) => {
  const deps = useMemo(() => ({ ...defaultDeps, ...depsOverride }), [depsOverride]);
  const [threshold, setThreshold] = useState(() => loadSetting("threshold", DEFAULT_THRESHOLD));
  const [amount, setAmount] = useState(() => loadSetting("amount", DEFAULT_TOPUP_AMOUNT));
  const [manual, setManual] = useState(() => loadManualAddresses());
  const [manualInput, setManualInput] = useState("");
  const [data, setData] = useState({ sources: null, balances: {}, budgets: {}, loading: false, error: "", at: null });
  const [statuses, setStatuses] = useState({});
  const [confirm, setConfirm] = useState(null); // { targets, adminBalance, error }
  const [running, setRunning] = useState(false);
  const requestRef = useRef(0);
  const manualRef = useRef(manual);
  manualRef.current = manual;

  const load = useCallback(async ({ force = false } = {}) => {
    const requestId = ++requestRef.current;
    setData((current) => ({ ...current, loading: true, error: "" }));
    try {
      const sources = await deps.readSources({ force });
      const { bots } = readLocalBots();
      // Bidders and sellers only appear in events (not in factory.allUsers), so they are read and can be flagged low too.
      const eventAddresses = Array.from(addressesFromEvents(sources.events || []).keys());
      const addresses = Array.from(new Set([...sources.users, ...eventAddresses, ...manualRef.current, ...Array.from(bots)].map((a) => String(a).toLowerCase()).filter(isAddressLike)));
      const [balances, budgets] = await Promise.all([deps.readBalances(addresses), deps.readBudgets(addresses)]);
      if (requestId === requestRef.current) setData({ sources, balances, budgets, loading: false, error: sources.warning || "", at: Date.now() });
    } catch (error) {
      if (requestId === requestRef.current) setData((current) => ({ ...current, loading: false, error: error?.message || "Could not read participants." }));
    }
  }, [deps]);

  useEffect(() => { load(); }, [load]);
  // Auto-refresh while the tab is visible. One batched read per tick (the RPC rate limiter still applies).
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden && !running) load(); }, refreshMs);
    return () => window.clearInterval(id);
  }, [load, refreshMs, running]);
  // A manually added address changes the list: reload once.
  const manualKey = manual.join(",");
  const firstManual = useRef(true);
  useEffect(() => { if (firstManual.current) { firstManual.current = false; return; } load(); }, [manualKey, load]);

  const thresholdWei = useMemo(() => parseNative(threshold), [threshold]);
  const rows = useMemo(() => {
    const { bots, labels } = readLocalBots();
    return buildParticipantRows({
      users: data.sources?.users || [], events: data.sources?.events || [], manual, bots, labels,
      balances: data.balances, budgets: data.budgets, latestBlock: data.sources?.latestBlock ?? null, thresholdWei,
    });
  }, [data, manual, thresholdWei]);
  // The connected admin wallet is excluded from "Top up all" (it would fund itself); it can still be topped up row by row.
  const adminLower = String(adminAccount || "").toLowerCase();
  const lowRows = selectLowRows(rows).filter((row) => row.address !== adminLower);
  const amountWei = parseNative(amount);

  const changeThreshold = (value) => { setThreshold(value); saveSetting("threshold", value); };
  const changeAmount = (value) => { setAmount(value); saveSetting("amount", value); };
  const addManual = () => {
    const address = manualInput.trim().toLowerCase();
    if (!isAddressLike(address) || manual.includes(address)) return;
    const next = [...manual, address];
    setManual(next);
    saveManualAddresses(next);
    setManualInput("");
  };

  const openConfirm = async (targets) => {
    setConfirm({ targets, adminBalance: null, error: "" });
    try {
      setConfirm({ targets, adminBalance: await deps.readAdminBalance(adminAccount), error: "" });
    } catch (error) {
      setConfirm({ targets, adminBalance: null, error: error?.message || "Admin balance unavailable" });
    }
  };
  const start = async () => {
    const targets = confirm.targets;
    setConfirm(null);
    setRunning(true);
    setStatuses({});
    await runTopUps({
      targets, amountWei, send: deps.send, waitFor: deps.waitFor,
      getAdminBalance: () => deps.readAdminBalance(adminAccount),
      onStatus: (address, status) => setStatuses((current) => ({ ...current, [address]: status })),
    });
    setRunning(false);
    load({ force: true });
  };

  const plan = confirm ? planTopUp({ rows: confirm.targets, amountText: amount }) : null;
  const enough = confirm?.adminBalance != null && plan?.amountWei ? confirm.adminBalance >= plan.totalWei + ADMIN_GAS_RESERVE_WEI : null;
  const symbol = getTargetNetwork().nativeCurrency?.symbol || "TEST";

  return (
    <Box sx={cardSx} data-testid="participants-gas-card">
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 2 }}>
        <Box>
          <Typography variant="h6">Participants gas</Typography>
          <Typography variant="body2" color="text.secondary">
            {symbol} balance and budget of every known participant (factory users, bidders, sellers, bots, addresses you add). Refreshes every 60 s while this page is visible. Top-ups are manual only.
          </Typography>
        </Box>
        <Button size="small" variant="outlined" onClick={() => load({ force: true })} disabled={data.loading || running}>{data.loading ? "Loading..." : "Refresh"}</Button>
      </Box>
      {data.error ? <Typography color="error" variant="body2" sx={{ mt: 1 }}>{data.error}</Typography> : null}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center", mt: 2 }}>
        <TextField size="small" label={`Low-balance threshold (${symbol})`} value={threshold} onChange={(e) => changeThreshold(e.target.value)} error={threshold !== "" && thresholdWei === null} inputProps={{ "aria-label": "Threshold" }} />
        <TextField size="small" label={`Top-up amount (${symbol})`} value={amount} onChange={(e) => changeAmount(e.target.value)} error={amount !== "" && amountWei === null} inputProps={{ "aria-label": "Top-up amount" }} />
        <TextField size="small" label="Add address (e.g. a bot)" value={manualInput} onChange={(e) => setManualInput(e.target.value)} inputProps={{ "aria-label": "Add address" }} sx={{ minWidth: 300 }} />
        <Button size="small" variant="outlined" onClick={addManual} disabled={!isAddressLike(manualInput.trim())}>Add</Button>
        <Button size="small" variant="contained" disabled={!lowRows.length || !amountWei || running} onClick={() => openConfirm(lowRows.map((row) => row.address))}>
          Top up all below threshold ({lowRows.length})
        </Button>
      </Box>

      <Box sx={{ overflowX: "auto", mt: 2 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Pid</th><th>Address</th><th>{symbol}</th><th>Budget</th><th>Last activity</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.address} data-testid="participant-row" data-low={row.low ? "true" : "false"}
                style={{ borderTop: "1px solid #e3e7f5", background: row.low ? "#fdecea" : "transparent" }}>
                <td style={mono}>{row.pid}</td>
                <td>
                  <span style={mono}>{row.address}</span>{" "}
                  <Button size="small" onClick={() => navigator.clipboard?.writeText(row.address)} aria-label={`Copy ${row.address}`}>Copy</Button>
                  {row.label ? <strong> {row.label}</strong> : null}{row.isBot ? " (bot)" : ""}
                </td>
                <td style={mono}>{row.balanceWei === null ? "—" : formatNative(row.balanceWei)}</td>
                <td style={mono}>{row.budget === "" ? "—" : row.budget}</td>
                <td style={{ fontSize: 12 }}>{row.lastBlock === null ? "—" : `block ${row.lastBlock}${row.blocksAgo !== null ? ` (${row.blocksAgo} blocks ago)` : ""}`}</td>
                <td style={{ fontSize: 12 }} data-testid="row-status">
                  {statusText(statuses[row.address])}
                  {statuses[row.address]?.hash ? <> <a href={explorerTxUrl(statuses[row.address].hash)} target="_blank" rel="noopener noreferrer">tx</a></> : null}
                </td>
                <td><Button size="small" variant="outlined" disabled={!amountWei || running} onClick={() => openConfirm([row.address])}>Top up</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !data.loading ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No participants found yet.</Typography> : null}
      </Box>

      <Dialog open={Boolean(confirm)} onClose={() => setConfirm(null)}>
        <DialogTitle>Confirm top-up</DialogTitle>
        <DialogContent>
          {plan ? (
            <>
              <Typography data-testid="confirm-summary">
                Send {amount} {symbol} to {plan.count} address{plan.count === 1 ? "" : "es"}. Total: {plan.amountWei ? formatNative(plan.totalWei) : "—"} {symbol}.
              </Typography>
              <Typography data-testid="confirm-admin-balance" sx={{ mt: 1 }}>
                Your balance: {confirm.adminBalance === null ? "loading..." : `${formatNative(confirm.adminBalance)} ${symbol}`}
              </Typography>
              {confirm.error ? <Typography color="error" sx={{ mt: 1 }}>{confirm.error}</Typography> : null}
              {enough === false ? <Typography color="error" sx={{ mt: 1 }}>Your balance does not cover every transfer. The run stops when it runs out.</Typography> : null}
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>One transaction per address, sent one after another.</Typography>
            </>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="contained" onClick={start} disabled={!amountWei || confirm?.adminBalance === null || confirm?.adminBalance === undefined}>Confirm and send</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

// Admin only: draws nothing for anyone whose connected wallet is not on REACT_APP_ADMIN_ADDRESSES.
const ParticipantsGasCard = (props) => {
  const { account, isAdmin } = useIsAdminWallet({ allowlist: props.allowlist });
  return isAdmin ? <ParticipantsGasCardBody adminAccount={account} {...props} /> : null;
};

export default ParticipantsGasCard;
