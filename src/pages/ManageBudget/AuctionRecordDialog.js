// Admin record of one auction (same layout as src/market/AuctionDatabaseDialog.js): Record, Bids, Ledger and
// Audit history tabs, all rebuilt from chain events. The auction payload is winner-only: it is never fetched here.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
} from "@mui/material";
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { readCancelledSet, readHiddenSet } from "../../real_ethereum/adminChain";
import { chainNowMs } from "../../real_ethereum/chainClock";
import { createAdminActions } from "./adminActions";
import { createChainLogReader } from "./adminAuditReader";
import { getAdminActionAvailability, mapAuctionAdminRow } from "./adminCardData";
import { readAuctionHistory } from "./auctionHistory";
import StatusLabel from "./AuctionStatusLabel";
import { adminHeadCellSx, adminPrimaryButtonSx } from "./AdminCard";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const mono = { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" };

export const readAuctionRow = async (address) => {
  const options = { ...READ_OPTIONS, factoryAddress: getActiveFactoryAddress() };
  const summary = await readOnlyCall(({ campaign }) => campaign(address).methods.getListSummary(), 1, options);
  const hidden = await readHiddenSet([address], { options }).catch(() => new Set());
  const cancelled = summary?.[8] ? await readCancelledSet([address], { options }).catch(() => new Set()) : new Set();
  const key = address.toLowerCase();
  return mapAuctionAdminRow({ address, summary, hidden: hidden.has(key), cancelled: cancelled.has(key) });
};

const timeText = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : "-");

const HistoryTable = ({ columns, rows, empty = "No records." }) => (
  <div className="tableScrollWrap">
    <Table size="small">
      <TableHead>
        <TableRow>{columns.map((column) => <TableCell key={column.key} sx={adminHeadCellSx}>{column.label}</TableCell>)}</TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            {columns.map((column) => (
              <TableCell key={column.key} sx={column.mono ? mono : undefined}>{column.render ? column.render(row) : String(row[column.key] ?? "-")}</TableCell>
            ))}
          </TableRow>
        ))}
        {!rows.length ? <TableRow><TableCell colSpan={columns.length}>{empty}</TableCell></TableRow> : null}
      </TableBody>
    </Table>
  </div>
);

const BID_COLUMNS = [
  { key: "bidder", label: "Bidder", mono: true },
  { key: "amount", label: "Amount" },
  { key: "cumulative", label: "Cumulative" },
  { key: "budgetBefore", label: "Budget before" },
  { key: "budgetAfter", label: "Budget after" },
  { key: "timeSec", label: "Time", render: (row) => timeText(row.timeSec) },
];
const LEDGER_COLUMNS = [
  { key: "type", label: "Type" },
  { key: "who", label: "Account", mono: true },
  { key: "detail", label: "Detail" },
  { key: "blockNumber", label: "Block" },
];
const AUDIT_COLUMNS = [
  { key: "type", label: "Type" },
  { key: "actor", label: "By", mono: true },
  { key: "detail", label: "Detail" },
  { key: "blockNumber", label: "Block" },
];

const AuctionRecordDialog = ({
  address,
  canWrite = false,
  actions: actionsOverride,
  loadRow = readAuctionRow,
  loadHistory,
  onChanged,
  onClose,
}) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [row, setRow] = useState(null);
  const [history, setHistory] = useState(null);
  const [minimum, setMinimum] = useState("");
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const refreshRow = useCallback(async () => {
    const next = await loadRow(address);
    setRow(next);
    setMinimum(next.minimum);
  }, [address, loadRow]);

  useEffect(() => {
    let live = true;
    refreshRow().catch((rowError) => live && setError(rowError?.message || "Could not read the auction."));
    const factoryAddress = getActiveFactoryAddress();
    const read = loadHistory || (() => readAuctionHistory({ campaign: address, factoryAddress, reader: createChainLogReader(factoryAddress) }));
    Promise.resolve()
      .then(read)
      .then((value) => live && setHistory(value))
      .catch((historyError) => live && setHistory({ error: historyError?.message || "History unavailable.", bids: [], ledger: [], audit: [] }));
    return () => {
      live = false;
    };
  }, [address, refreshRow, loadHistory]);

  const nowSec = Math.floor(chainNowMs() / 1000);
  const can = row ? getAdminActionAvailability(row, nowSec) : null;
  const editable = Boolean(canWrite && can?.editMinimum);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await actions.setMinimum(address, minimum);
      await refreshRow();
      await onChanged?.();
      setSaved(true);
    } catch (saveError) {
      setError(saveError?.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const original = history?.originalMinimum || row?.minimum || "";
  return (
    <Dialog open fullWidth maxWidth="md" onClose={busy ? undefined : onClose} aria-labelledby="auction-record-title">
      <DialogTitle id="auction-record-title">Auction record</DialogTitle>
      {busy || (!row && !error) ? <LinearProgress /> : null}
      <DialogContent>
        {error ? <Alert severity="error">{error}</Alert> : null}
        {saved ? <Alert severity="success">Minimum updated.</Alert> : null}
        {row ? (
          <>
            <p style={mono}>
              {address} {can ? <StatusLabel status={can.status} hidden={row.hidden} /> : null}
            </p>
            <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" allowScrollButtonsMobile>
              <Tab label="Record" />
              <Tab label={`Bids (${history ? history.bids.length : "..."})`} />
              <Tab label="Ledger" />
              <Tab label="Audit history" />
            </Tabs>
            {tab > 0 && history?.error ? <Alert severity="warning" sx={{ mt: 1 }}>History unavailable: {history.error}</Alert> : null}
            {tab > 0 && history?.healthNote ? <Alert severity="warning" sx={{ mt: 1 }} data-testid="history-incomplete">History incomplete: {history.healthNote}.</Alert> : null}
            {tab > 0 && history && !history.error ? (
              <p style={{ fontSize: 12, color: "#5e638a" }}>Chain events from block {history.fromBlock} to {history.latest} (last {history.lookback} blocks).</p>
            ) : null}
            {tab === 0 ? (
              <form id="auction-record-form" onSubmit={save} style={{ display: "grid", gap: 12, marginTop: 12 }}>
                {!editable ? (
                  <Alert severity="info">
                    {canWrite
                      ? "The minimum is read-only because bidding has started or the auction has ended."
                      : "Read-only: this wallet is not an on-chain admin of the active factory."}
                  </Alert>
                ) : null}
                <TextField label="Seller address" value={row.manager} InputProps={{ readOnly: true }} />
                <TextField label="Description" value={row.description} InputProps={{ readOnly: true }} />
                <TextField label="Original minimum bid" value={original} InputProps={{ readOnly: true }} />
                <TextField label="Adjusted minimum bid" value={editable ? minimum : row.minimum} onChange={(event) => setMinimum(event.target.value)} disabled={busy || !editable} inputProps={{ inputMode: "numeric" }} />
                <TextField label="Closing time" value={row.endTime ? new Date(row.endTime * 1000).toLocaleString() : ""} InputProps={{ readOnly: true }} />
              </form>
            ) : null}
            {tab === 1 ? <HistoryTable columns={BID_COLUMNS} rows={history?.bids || []} empty={history ? "No bids in the loaded range." : "Loading..."} /> : null}
            {tab === 2 ? <HistoryTable columns={LEDGER_COLUMNS} rows={history?.ledger || []} empty={history ? "No ledger events in the loaded range." : "Loading..."} /> : null}
            {tab === 3 ? <HistoryTable columns={AUDIT_COLUMNS} rows={history?.audit || []} empty={history ? "No admin actions in the loaded range." : "Loading..."} /> : null}
          </>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1 }}>
        {tab === 0 && editable ? (
          <Button variant="contained" type="submit" form="auction-record-form" disabled={busy || minimum === row?.minimum} sx={adminPrimaryButtonSx}>
            Save changes
          </Button>
        ) : null}
        <Button disabled={busy} onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
};

export default AuctionRecordDialog;
