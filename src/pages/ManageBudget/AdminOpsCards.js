/* eslint-env es2020 */
// Read-only Admin Zone cards: users & budgets, architecture & operations, audit events, faucet.
// None of these send transactions. They refresh from event subscriptions / the shared registry,
// not from their own timers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import SharedAdminCard, { AdminRefreshButton, adminHeadCellSx, adminPrimaryButtonSx } from "./AdminCard";
import { readOnlyCall, readOnlyExecute } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress, subscribeToMarketChanges } from "../../real_ethereum/marketConfig";
import { getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import { getConfiguredRpcUrls } from "../../real_ethereum/rpcConfig";
import { canUseLiveEvents, factorySocket } from "../../real_ethereum/socketFactory";
import { notifyBudgetChanged, subscribeToBudgetChanges } from "../../real_ethereum/budget";
import { readCancelledSet, readFactoryOwner, readHiddenSet } from "../../real_ethereum/adminChain";
import { createAdminActions } from "./adminActions";
import { subscribeActiveAuctionRegistry } from "../../real_ethereum/activeAuctionRegistry";
import { getLivePresence, isPresenceConfigured } from "../../telemetry/presenceClient";
import { LOCAL_BOTS_KEY } from "../../telemetry/botPresence";
import AdminGasCards from "./AdminGasCards";
import { mapWithConcurrency, shortAddress } from "./reportUtils";
import { describeRangeHealth } from "../../real_ethereum/chunkedLogs";
import {
  AUDIT_CAMPAIGN_LIMIT,
  getAuditLookbackBlocks,
  getAuditSnapshot,
} from "./adminAuditReader";
import {
  AUDIT_EVENT_TYPES,
  filterAuditEvents,
  getAdminActionAvailability,
  inspectEventJson,
  mapAuctionAdminRow,
  joinUrl,
  mapBotConfig,
  mapUserRows,
  pageAuctionRows,
  toServiceRow,
  AUCTION_ADMIN_PAGE_SIZE,
} from "./adminCardData";
import StatusLabel from "./AuctionStatusLabel";
import { Countdown, useChainNowSec } from "./AdminCountdown";
import useAuctionAdminDialogs from "./useAuctionAdminDialogs";
import { buildRunbook } from "./architectureRunbook";
import { useAutoReturn } from "./ParticipantsAutoReturn";
import { readUserStates, readUsersList } from "./usersChainReaders";
import { REFRESH_MS, addressesFromEvents, isAddressLike } from "./participantsGasData";
import { adminAddressesFromEvents, classifyAdmin, formatAgo, isOnline, lastSeenMs, unionParticipants } from "./userPresence";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const PROBE_TIMEOUT_MS = 6000;
const LIVE_FACTORY_EVENTS = [
  "BudgetChanged",
  "AuctionCreatedDetailed",
  "AuctionFinalizationFailed",
  "GlobalBudgetReset",
  "MinimumChanged",
  "AuctionCancelled",
  "AuctionHiddenChanged",
];

const readLocalBots = () => {
  try {
    return mapBotConfig(JSON.parse(window.localStorage.getItem(LOCAL_BOTS_KEY) || "[]"));
  } catch (_) {
    return mapBotConfig([]);
  }
};

// Refresh on events instead of intervals: factory socket events when a WS RPC is configured, plus the
// shared active-auction registry (already synced site-wide), budget changes and market switches.
export const useAdminLiveRefresh = (refresh, { debounceMs = 1500 } = {}) => {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let timer;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refreshRef.current(), debounceMs);
    };
    const unsubscribers = [
      subscribeActiveAuctionRegistry(bump),
      subscribeToBudgetChanges(bump),
      subscribeToMarketChanges(bump),
    ];
    const sockets = [];
    if (canUseLiveEvents()) {
      LIVE_FACTORY_EVENTS.forEach((name) => {
        try {
          const subscription = factorySocket.events[name]();
          subscription.on("data", bump);
          subscription.on("error", () => {});
          sockets.push(subscription);
        } catch (_) {
          // Live events are optional; the registry subscription and Refresh button still work.
        }
      });
    }
    return () => {
      window.clearTimeout(timer);
      unsubscribers.forEach((off) => off?.());
      sockets.forEach((subscription) => subscription.unsubscribe?.());
    };
  }, [debounceMs]);
};

// Adapter over the shared market-style card: Refresh becomes the outlined pill action.
const AdminCard = ({ title, open, onToggle, onRefresh, loading, children }) => (
  <SharedAdminCard
    title={title}
    open={open}
    onToggle={onToggle}
    action={onRefresh ? <AdminRefreshButton onClick={onRefresh} loading={loading} /> : null}
  >
    {children}
  </SharedAdminCard>
);

const useCardState = (initialOpen = false) => {
  const [open, setOpen] = useState(initialOpen);
  return [open, () => setOpen((value) => !value)];
};

const ErrorLine = ({ error }) =>
  error ? (
    <Typography color="error" variant="body2" sx={{ mb: 1 }}>
      {error}
    </Typography>
  ) : null;

const monoSx = { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" };

// ---- Users and budgets -------------------------------------------------------------------------

// Runs one admin transaction at a time and reports the outcome; `onDone` refreshes the card.
export const useAdminActionRunner = (onDone) => {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const run = useCallback(
    async (label, action) => {
      setBusy(label);
      setMessage(null);
      let outcome;
      try {
        await action();
        outcome = { ok: true, text: `${label}: done` };
      } catch (error) {
        outcome = { ok: false, text: `${label} failed: ${error?.message || error}` };
      }
      // One batched update: the message appears exactly when the buttons are usable again.
      setMessage(outcome);
      setBusy("");
      if (outcome.ok) {
        try {
          await onDone?.();
        } catch (_) {
          // the refresh reports its own errors
        }
      }
    },
    [onDone]
  );
  return { busy, message, run };
};

const ActionMessage = ({ message }) =>
  message ? (
    <Typography variant="body2" color={message.ok ? "success.main" : "error"} sx={{ mt: 1 }} role="status">
      {message.text}
    </Typography>
  ) : null;

const WriteNotice = ({ canWrite }) =>
  canWrite ? null : (
    <Typography variant="body2" sx={{ color: "#8a5a00", mb: 1 }} data-testid="admin-write-disabled">
      Read-only: this wallet is not an on-chain admin of the active factory, so write actions are disabled.
    </Typography>
  );

const EMPTY_CHAIN = { budgets: {}, held: {}, disabled: new Set(), admins: new Set(), owner: "" };
// Folds one readUserStates result into the accumulated per-address state (re-read addresses are replaced).
const mergeChain = (current, read) => {
  if (!read) return current;
  const reread = new Set(Object.keys(read.budgets));
  const keep = (set) => Array.from(set).filter((key) => !reread.has(key));
  return {
    budgets: { ...current.budgets, ...read.budgets },
    held: { ...current.held, ...read.held },
    disabled: new Set([...keep(current.disabled), ...read.disabled]),
    admins: new Set([...keep(current.admins), ...read.admins]),
    owner: read.owner || current.owner,
  };
};

export const UsersBudgetsCard = ({ canWrite = false, actions: actionsOverride }) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [budgetDraft, setBudgetDraft] = useState({ address: "", value: "" });
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({
    users: { addresses: [], warning: "" }, usersLoaded: false, chain: EMPTY_CHAIN,
    audit: null, historyError: "", auditPending: true, sweeps: {}, sweepsOk: null, loading: false, error: "",
  });
  const requestRef = useRef(0);
  // Faucet sweep records (lastSeen) through the shared 30 s cache + the same wallet-proof/password auth as Participants gas.
  const autoReturn = useAutoReturn();
  const autoLoadRef = useRef(autoReturn.load);
  autoLoadRef.current = autoReturn.load;
  const sweepsEnabled = autoReturn.enabled;
  const knownRef = useRef(new Set());

  // Resolves lowercase address -> sweep, or null when unavailable (not configured, 401, network). Never throws.
  const readSweeps = useCallback(async (force) => {
    if (!sweepsEnabled) return null;
    try { return (await autoLoadRef.current("", { force })) || null; } catch (_) { return null; }
  }, [sweepsEnabled]);

  // Progressive load: each source renders as soon as it is ready and none waits for another.
  //   1. factory users (allUsersCount + batched allUsers) and their batched budget/held/disabled/isAdmin + owner -> first paint
  //   2. the shared audit snapshot (already started in parallel; no second log scan) -> bidders, sellers, last change
  //   3. faucet /admin/sweeps (started in parallel) -> faucet-only wallets, Last seen, Online now
  // Addresses that only a later source knows get their own batched state read before they are added.
  const load = useCallback(async (force = false, forceSweeps = false) => {
    const requestId = ++requestRef.current;
    const live = () => requestId === requestRef.current;
    const factoryAddress = getActiveFactoryAddress();
    setState((current) => ({ ...current, loading: true, error: "", auditPending: true }));
    const auditPromise = getAuditSnapshot(factoryAddress, { force }).then(
      (audit) => ({ audit, historyError: "" }),
      (auditError) => ({ audit: null, historyError: auditError?.message || "audit read failed" })
    );
    const sweepsPromise = readSweeps(forceSweeps);
    const known = new Set();
    const readNew = async (addresses, withOwner = false) => {
      const fresh = addresses.filter((address) => !known.has(address.toLowerCase()));
      fresh.forEach((address) => known.add(address.toLowerCase()));
      return fresh.length || withOwner ? readUserStates(fresh, { factoryAddress, withOwner }) : null;
    };
    const usersStage = (async () => {
      try {
        const list = await readUsersList({ factoryAddress });
        if (!live()) return;
        const read = await readNew(list.addresses, true);
        if (!live()) return;
        setState((current) => ({ ...current, users: { addresses: list.addresses, warning: list.warning }, usersLoaded: true, chain: mergeChain(current.chain, read), error: "" }));
      } catch (error) {
        if (live()) setState((current) => ({ ...current, usersLoaded: true, error: error?.message || "Could not read users." }));
      }
    })();
    const auditStage = (async () => {
      await usersStage;
      const result = await auditPromise;
      if (!live()) return;
      const read = await readNew(Array.from(addressesFromEvents(result.audit?.events || []).keys()));
      if (!live()) return;
      setState((current) => ({ ...current, audit: result.audit, historyError: result.historyError, auditPending: false, chain: mergeChain(current.chain, read) }));
    })();
    const sweepsStage = (async () => {
      await usersStage;
      const sweeps = await sweepsPromise;
      if (!live()) return;
      const read = await readNew(Object.keys(sweeps || {}).filter(isAddressLike));
      if (!live()) return;
      setState((current) => ({ ...current, sweeps: sweeps || {}, sweepsOk: Boolean(sweeps), chain: mergeChain(current.chain, read) }));
    })();
    await Promise.all([usersStage, auditStage, sweepsStage]);
    if (live()) setState((current) => ({ ...current, loading: false }));
  }, [readSweeps]);

  // Starts on mount even while collapsed (like Participants gas), so opening the card is instant.
  useEffect(() => {
    load();
  }, [load]);
  useAdminLiveRefresh(() => open && load(true));
  // Last seen refreshes at the Participants gas cadence (60 s), only while the tab is visible and the card is open.
  useEffect(() => {
    if (!open || !sweepsEnabled) return undefined;
    const id = window.setInterval(async () => {
      if (document.hidden) return;
      const sweeps = await readSweeps(false);
      setState((current) => ({ ...current, sweeps: sweeps || current.sweeps, sweepsOk: Boolean(sweeps) }));
      if (sweeps && Object.keys(sweeps).some((address) => isAddressLike(address) && !knownRef.current.has(address))) load();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [open, sweepsEnabled, readSweeps, load]);
  const { busy, message, run } = useAdminActionRunner(() => load(true));

  const rows = useMemo(() => {
    const events = state.audit?.events || [];
    const { addresses, registered } = unionParticipants({
      users: state.users.addresses,
      events,
      sweepAddresses: Object.keys(state.sweeps),
    });
    // Participant roles: allUsers + seller/user/contributor/bidder in events (never args.by / args.admin).
    const roles = new Set([...registered, ...addressesFromEvents(events).keys()]);
    const admins = new Set([...state.chain.admins, ...adminAddressesFromEvents(events)]);
    if (state.chain.owner) admins.add(state.chain.owner);
    const { labels, bots } = readLocalBots();
    return mapUserRows({
      addresses,
      budgets: state.chain.budgets,
      events: events.filter((event) => event.name === "BudgetChanged"),
      labels,
      bots,
      held: state.chain.held,
      disabled: state.chain.disabled,
    }).map((row) => ({
      ...row,
      registered: registered.has(row.address.toLowerCase()),
      ...classifyAdmin({ address: row.address, admins, roles }),
    }));
  }, [state.users, state.audit, state.sweeps, state.chain]);
  knownRef.current = new Set(rows.map((row) => row.address.toLowerCase()));
  const budgetErrors = rows.filter((row) => row.budget === "unavailable").length;
  const warnings = [state.users.warning, budgetErrors ? `${budgetErrors} budget reads failed.` : ""].filter(Boolean);

  const nowMs = Date.now();
  const onlineNow = rows.filter((row) => !row.adminOnly && isOnline(state.sweeps[row.address.toLowerCase()], nowMs)).length;
  const history = state.historyError ? "unavailable" : state.audit?.failedRanges?.length ? "partial" : "ok";
  const historyNote = describeRangeHealth(state.audit || {});

  return (
    <AdminCard
      title="Users and budgets"
      open={open}
      onToggle={toggle}
      onRefresh={() => load(true, true)}
      loading={state.loading}
    >
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Every wallet that entered: registered users from the factory, plus bidders, sellers and wallets known to the faucet. Their available budget, funds held by leading bids, last budget change and last seen. Admins can set a user's total budget or disable them.
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600 }} data-testid="online-now">Online now: {onlineNow}</Typography>
      {state.sweepsOk === false ? (
        <Typography variant="caption" color="text.secondary" display="block" data-testid="online-unavailable">Online status unavailable</Typography>
      ) : null}
      <WriteNotice canWrite={canWrite} />
      <Typography variant="caption" color="text.secondary" display="block">
        Disabling blocks creating and bidding for that wallet only; a new wallet bypasses it.
      </Typography>
      <ErrorLine error={state.error} />
      {warnings.map((warning) => (
        <Typography key={warning} variant="body2" sx={{ color: "#8a5a00", mb: 0.5 }}>
          {warning}
        </Typography>
      ))}
      {history !== "ok" ? (
        <Typography variant="body2" sx={{ color: "#8a5a00", mb: 0.5 }}>
          {history === "unavailable" ? `Budget history unavailable (${state.historyError}).` : `Budget history incomplete: ${historyNote}.`}
        </Typography>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        {rows.length} users{state.usersLoaded ? "" : " (loading...)"}. Newest activity first. Budget changes are read from the last {state.audit?.lookback ?? getAuditLookbackBlocks()} blocks. Labels come from this browser's bot config.
      </Typography>
      <div className="tableScrollWrap">
        <Table size="small">
          <TableHead>
            <TableRow>
              {["User", "Available", "Held", "Total", "Last change", "Last seen"].map((name) => (
                <TableCell key={name} sx={adminHeadCellSx}>{name}</TableCell>
              ))}
              {canWrite ? <TableCell sx={adminHeadCellSx}>Actions</TableCell> : null}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.address}>
                <TableCell>
                  <span style={monoSx} title={row.address}>
                    {shortAddress(row.address)}
                  </span>{" "}
                  {row.label ? <strong>{row.label}</strong> : null}{" "}
                  {row.isBot ? <Chip size="small" label="bot" color="secondary" /> : null}{" "}
                  {row.disabled ? <Chip size="small" label="disabled" color="error" /> : null}{" "}
                  {row.isAdmin ? <Chip size="small" label="admin" variant="outlined" /> : null}
                  {row.registered ? null : (
                    <Typography variant="caption" color="text.secondary" display="block">not registered yet</Typography>
                  )}
                </TableCell>
                <TableCell sx={monoSx}>{row.budget}</TableCell>
                <TableCell sx={monoSx}>{row.held}</TableCell>
                <TableCell sx={monoSx}>{row.total}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {row.lastChange
                    ? `${row.lastChange.direction} ${row.lastChange.amount} at block ${row.lastChange.blockNumber}`
                    : state.auditPending
                      ? "loading..."
                    : history === "unavailable"
                      ? "budget history unavailable"
                      : `none in last ${state.audit?.lookback ?? getAuditLookbackBlocks()} blocks`}
                </TableCell>
                <TableCell sx={{ fontSize: 12, whiteSpace: "nowrap" }} data-testid="last-seen">
                  {(() => {
                    const sweep = state.sweeps[row.address.toLowerCase()];
                    const seen = lastSeenMs(sweep);
                    if (seen === null) return "-";
                    return (
                      <>
                        <span title={new Date(seen).toISOString()}>{formatAgo(seen, nowMs)}</span>
                        {isOnline(sweep, nowMs) ? <Chip size="small" label="Online" color="success" sx={{ ml: 0.5 }} /> : null}
                      </>
                    );
                  })()}
                </TableCell>
                {canWrite ? (
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    <Button
                      size="small"
                      disabled={Boolean(busy) || row.adminOnly}
                      onClick={() => setBudgetDraft({ address: row.address, value: row.total })}
                    >
                      Set budget
                    </Button>
                    <Button
                      size="small"
                      color={row.disabled ? "primary" : "error"}
                      disabled={Boolean(busy) || row.adminOnly}
                      onClick={() => {
                        const name = row.label || shortAddress(row.address);
                        // Same confirmation as the marketplace admin, before the wallet asks to sign.
                        if (!window.confirm(row.disabled ? `Enable ${name}?` : `Disable ${name}?`)) return;
                        run(row.disabled ? "Enable user" : "Disable user", () => actions.setDisabled(row.address, !row.disabled));
                      }}
                    >
                      {row.disabled ? "Enable" : "Disable"}
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {canWrite && budgetDraft.address ? (
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1.5, flexWrap: "wrap" }}>
          <Typography variant="body2">
            Total budget for <span style={monoSx}>{shortAddress(budgetDraft.address)}</span> (available = total - held):
          </Typography>
          <TextField
            size="small"
            label="Total budget"
            value={budgetDraft.value}
            onChange={(event) => setBudgetDraft((current) => ({ ...current, value: event.target.value }))}
          />
          <Button
            size="small"
            variant="contained"
            sx={adminPrimaryButtonSx}
            disabled={Boolean(busy)}
            onClick={() =>
              run("Set budget", async () => {
                await actions.setUserBudget(budgetDraft.address, budgetDraft.value);
                notifyBudgetChanged({ factoryAddress: getActiveFactoryAddress() });
                setBudgetDraft({ address: "", value: "" });
              })
            }
          >
            Save
          </Button>
          <Button size="small" onClick={() => setBudgetDraft({ address: "", value: "" })}>
            Cancel
          </Button>
        </Box>
      ) : null}
      <ActionMessage message={message} />
    </AdminCard>
  );
};

// ---- Architecture & operations -----------------------------------------------------------------

const probeJson = async (url) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    // No cookies, no custom headers, no tokens.
    const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit" });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.ok !== false && body !== null, detail: `HTTP ${response.status}, ${Date.now() - startedAt} ms`, body };
  } catch (error) {
    return { ok: false, detail: error?.name === "AbortError" ? "timed out" : "unreachable", body: null };
  } finally {
    window.clearTimeout(timer);
  }
};

export const getFaucetBaseUrl = () => String(process.env.REACT_APP_FAUCET_URL || "").trim();
export const getBotnetBaseUrl = () => String(process.env.REACT_APP_BOTNET_API_URL || "/api/botnet").trim();

export const RunbookBlock = ({ factoryAddress = getActiveFactoryAddress(), network = getTargetNetwork() }) => {
  const runbook = buildRunbook({ factoryAddress, network });
  return (
    <Box sx={{ mt: 2 }} data-testid="architecture-runbook">
      <Typography variant="subtitle1" sx={{ fontWeight: 700, color: "#002884" }}>
        How to access and maintain each component
      </Typography>
      {runbook.components.map((component) => (
        <Box key={component.name} sx={{ mt: 1.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{component.name}</Typography>
          {component.lines.map((line) => (
            <Typography key={line} variant="body2" color="text.secondary" sx={{ wordBreak: "break-word" }}>{line}</Typography>
          ))}
          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mt: 0.5 }}>
            {component.links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>{link.label}</a>
            ))}
          </Box>
        </Box>
      ))}
      <Typography variant="body2" sx={{ mt: 1.5, fontWeight: 600 }} data-testid="runbook-deploy">{runbook.deploy.text}</Typography>
    </Box>
  );
};

export const ArchitectureCard = () => {
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({ rows: [], loading: false, error: "", checkedAt: "" });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    const network = getTargetNetwork();
    const factoryAddress = getActiveFactoryAddress();
    const rows = [];

    const rpc = await (async () => {
      const startedAt = Date.now();
      try {
        const block = await readOnlyExecute(({ web3 }) => web3.eth.getBlockNumber(), undefined, READ_OPTIONS);
        return { ok: true, detail: `block ${String(block)}, ${Date.now() - startedAt} ms` };
      } catch (error) {
        return { ok: false, detail: error?.message || "RPC read failed" };
      }
    })();
    rows.push(toServiceRow("RPC", rpc));
    rows.push({ name: "RPC endpoints", status: "info", detail: `${getConfiguredRpcUrls().length} configured` });
    rows.push({ name: "Network", status: "info", detail: `${network.chainName} (chain id ${network.chainId})` });
    rows.push({ name: "Active factory", status: "info", detail: factoryAddress || "not configured" });

    const faucetUrl = getFaucetBaseUrl();
    rows.push(toServiceRow("Faucet GET /status", faucetUrl ? await probeJson(joinUrl(faucetUrl, "/status")) : null));

    if (isPresenceConfigured()) {
      const presence = await getLivePresence()
        .then(() => ({ ok: true, detail: "live endpoint reachable" }))
        .catch((error) => ({ ok: false, detail: error?.message || "unreachable" }));
      rows.push(toServiceRow("Presence API", presence));
    } else {
      rows.push(toServiceRow("Presence API", null));
    }

    const botnet = await probeJson(joinUrl(getBotnetBaseUrl(), "/health"));
    rows.push(toServiceRow("Botnet API GET /health", botnet));

    setState({ rows, loading: false, error: "", checkedAt: new Date().toLocaleTimeString() });
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useAdminLiveRefresh(() => open && load(), { debounceMs: 5000 });

  const color = (status) => (status === "ok" ? "success" : status === "down" ? "error" : "default");
  return (
    <AdminCard
      title="Architecture & Operations"
      open={open}
      onToggle={toggle}
      onRefresh={load}
      loading={state.loading}
    >
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Health of the services the experiment depends on. Read-only; no secrets are sent or shown.
      </Typography>
      <ErrorLine error={state.error} />
      {state.checkedAt ? (
        <Typography variant="caption" color="text.secondary">
          Checked {state.checkedAt}
        </Typography>
      ) : null}
      {state.rows.map((row) => (
        <Box key={row.name} sx={{ display: "flex", gap: 1.5, alignItems: "center", py: 0.5, borderTop: "1px solid #e3e7f5" }}>
          <Box sx={{ width: 190, fontWeight: 600, fontSize: 13 }}>{row.name}</Box>
          <Chip size="small" label={row.status} color={color(row.status)} variant={row.status === "info" ? "outlined" : "filled"} />
          <Box sx={{ ...monoSx, minWidth: 0 }}>{row.detail}</Box>
        </Box>
      ))}
      <RunbookBlock />
    </AdminCard>
  );
};

// ---- Audit events -----------------------------------------------------------------------------

export const AuditEventsCard = () => {
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({ events: [], loading: false, error: "", fromBlock: 0, latest: 0 });
  const [types, setTypes] = useState([]);
  const [query, setQuery] = useState("");
  const [inspected, setInspected] = useState(null);

  const load = useCallback(async (force = false) => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const audit = await getAuditSnapshot(getActiveFactoryAddress(), { force });
      setState({ ...audit, loading: false, error: "" });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error?.message || "Could not read events." }));
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useAdminLiveRefresh(() => open && load(true));

  const health = describeRangeHealth(state);
  const visible = useMemo(() => filterAuditEvents(state.events, { types, query }), [state.events, types, query]);
  const toggleType = (name) =>
    setTypes((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]));

  return (
    <AdminCard
      title="Audit events"
      open={open}
      onToggle={toggle}
      onRefresh={() => load(true)}
      loading={state.loading}
    >
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Factory and recent campaign events, newest first. Read-only.
      </Typography>
      <ErrorLine error={state.error} />
      {health ? (
        <Typography variant="body2" sx={{ color: "#8a5a00", mb: 0.5 }} data-testid="audit-range-health">
          Partial data: {health}.
        </Typography>
      ) : null}
      {(state.failedRanges || []).slice(0, 3).map((range) => (
        <Typography key={range.from} variant="caption" display="block" color="text.secondary" sx={monoSx}>
          blocks {range.from}-{range.to}: {range.error}
        </Typography>
      ))}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
        {AUDIT_EVENT_TYPES.map((name) => (
          <FormControlLabel
            key={name}
            control={<Checkbox size="small" checked={types.includes(name)} onChange={() => toggleType(name)} />}
            label={<span style={{ fontSize: 13 }}>{name}</span>}
          />
        ))}
        <TextField size="small" label="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        {visible.length} of {state.events.length} events, blocks {state.fromBlock} to {state.latest}. Payment and refund events cover
        up to {AUDIT_CAMPAIGN_LIMIT} recent auctions ({state.campaignCount ?? 0} found).
      </Typography>
      {visible.slice(0, 200).map((event) => (
        <Box key={event.id} sx={{ display: "flex", gap: 1, alignItems: "center", py: 0.5, borderTop: "1px solid #e3e7f5" }}>
          <Chip size="small" label={event.name} />
          <Box sx={{ flex: 1, minWidth: 0, ...monoSx }}>{event.summary}</Box>
          <Box sx={{ fontSize: 12, whiteSpace: "nowrap" }}>#{event.blockNumber}</Box>
          <Button size="small" onClick={() => setInspected(inspected?.id === event.id ? null : event)}>
            Inspect
          </Button>
        </Box>
      ))}
      {inspected ? (
        <Box component="pre" sx={{ ...monoSx, mt: 1, p: 1.5, background: "#f4f6fd", borderRadius: 2, overflow: "auto", whiteSpace: "pre-wrap" }}>
          {inspectEventJson(inspected)}
        </Box>
      ) : null}
    </AdminCard>
  );
};

// ---- Faucet ------------------------------------------------------------------------------------

export const FaucetCard = () => {
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({ loading: false, result: null });
  const faucetUrl = getFaucetBaseUrl();

  const load = useCallback(async () => {
    if (!faucetUrl) return;
    setState((current) => ({ ...current, loading: true }));
    setState({ loading: false, result: await probeJson(joinUrl(faucetUrl, "/status")) });
  }, [faucetUrl]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useAdminLiveRefresh(() => open && load(), { debounceMs: 5000 });

  return (
    <AdminCard
      title="Faucet"
      open={open}
      onToggle={toggle}
      onRefresh={faucetUrl ? load : undefined}
      loading={state.loading}
    >
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Test-fund faucet status. The faucet controls live on the faucet admin page.
      </Typography>
      <Button component={RouterLink} to="/admin/faucet" size="small" variant="contained" sx={{ ...adminPrimaryButtonSx, mb: 1.5 }}>
        Open faucet admin
      </Button>
      {!faucetUrl ? (
        <Typography variant="body2" color="text.secondary">
          REACT_APP_FAUCET_URL is not set for this deployment.
        </Typography>
      ) : state.result ? (
        <>
          <Typography variant="body2" color={state.result.ok ? "success.main" : "error"}>
            GET /status: {state.result.ok ? "ok" : "down"} ({state.result.detail})
          </Typography>
          {state.result.body ? (
            <Box component="pre" sx={{ ...monoSx, mt: 1, p: 1.5, background: "#f4f6fd", borderRadius: 2, overflow: "auto", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(state.result.body, null, 2)}
            </Box>
          ) : null}
        </>
      ) : null}
    </AdminCard>
  );
};

// ---- Auction controls ---------------------------------------------------------------------------

const lowerKey = (address) => String(address ?? "").toLowerCase();

export const AuctionControlsCard = ({ canWrite = false, actions: actionsOverride, reader }) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({ addresses: [], loading: false, error: "", tick: 0, progress: "" });
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [visible, setVisible] = useState(AUCTION_ADMIN_PAGE_SIZE);
  const [pending, setPending] = useState(null); // { address, value } for the minimum editor
  const cacheRef = useRef(new Map());
  const addressesRef = useRef([]);
  const requestRef = useRef(0);
  const queryRef = useRef("");
  const visibleRef = useRef(AUCTION_ADMIN_PAGE_SIZE);
  queryRef.current = appliedQuery;
  visibleRef.current = visible;
  const nowSec = useChainNowSec(open);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const readBatch = useCallback(async (batch, options) => {
    const summaries = await mapWithConcurrency(batch, 4, async (address) => {
      try {
        return await readOnlyCall(({ campaign }) => campaign(address).methods.getListSummary(), 1, options);
      } catch (_) {
        return null;
      }
    });
    const hidden = await readHiddenSet(batch, { options }).catch(() => new Set());
    const closed = batch.filter((_, index) => summaries[index]?.[8]);
    const cancelled = closed.length ? await readCancelledSet(closed, { options }).catch(() => new Set()) : new Set();
    batch.forEach((address, index) => {
      if (!summaries[index]) return;
      cacheRef.current.set(
        lowerKey(address),
        mapAuctionAdminRow({
          address,
          summary: summaries[index],
          cancelled: cancelled.has(lowerKey(address)),
          hidden: hidden.has(lowerKey(address)),
        })
      );
    });
  }, []);

  // Newest auctions first, loaded one page at a time. A search needs every description, so it loads the rest.
  const load = useCallback(
    async ({ force = false } = {}) => {
      const requestId = ++requestRef.current;
      setState((current) => ({ ...current, loading: true, error: "" }));
      try {
        if (reader) {
          const rows = await reader();
          cacheRef.current = new Map(rows.map((row) => [lowerKey(row.address), row]));
          addressesRef.current = rows.map((row) => row.address);
          if (requestId === requestRef.current) {
            setState((current) => ({ ...current, addresses: addressesRef.current, loading: false, tick: current.tick + 1 }));
          }
          return;
        }
        const options = { ...READ_OPTIONS, factoryAddress: getActiveFactoryAddress() };
        if (force || !addressesRef.current.length) {
          const all = await readOnlyCall(({ factory }) => factory.methods.getDeployedCampaigns(), 1, options);
          addressesRef.current = [...all].reverse();
        }
        if (force) cacheRef.current = new Map();
        const addresses = addressesRef.current;
        const wanted = queryRef.current.trim() ? addresses : addresses.slice(0, visibleRef.current);
        const missing = wanted.filter((address) => !cacheRef.current.has(lowerKey(address)));
        for (let start = 0; start < missing.length; start += AUCTION_ADMIN_PAGE_SIZE) {
          if (requestId !== requestRef.current) return;
          const batch = missing.slice(start, start + AUCTION_ADMIN_PAGE_SIZE);
          await readBatch(batch, options);
          if (requestId === requestRef.current) {
            setState((current) => ({
              ...current,
              addresses,
              tick: current.tick + 1,
              progress: missing.length > AUCTION_ADMIN_PAGE_SIZE ? `Loaded ${Math.min(start + batch.length, missing.length)} of ${missing.length}...` : "",
            }));
          }
        }
        if (requestId === requestRef.current) {
          setState((current) => ({ ...current, addresses, loading: false, progress: "", tick: current.tick + 1 }));
        }
      } catch (error) {
        if (requestId === requestRef.current) {
          setState((current) => ({ ...current, loading: false, error: error?.message || "Could not read auctions." }));
        }
      }
    },
    [reader, readBatch]
  );

  useEffect(() => {
    if (open) load();
  }, [open, load, appliedQuery, visible]);
  useAdminLiveRefresh(() => open && load({ force: true }));
  const refresh = useCallback(() => load({ force: true }), [load]);
  const { busy, message, run } = useAdminActionRunner(refresh);
  const dialogs = useAuctionAdminDialogs({ actions, canWrite, onChanged: refresh });

  const loadedRows = state.addresses.map((address) => cacheRef.current.get(lowerKey(address))).filter(Boolean);
  const page = pageAuctionRows({ rows: loadedRows, query: appliedQuery, visible });
  const searching = Boolean(appliedQuery.trim());
  const hasMore = searching ? page.hasMore : state.addresses.length > visible;

  return (
    <AdminCard title="Auction controls" open={open} onToggle={toggle} onRefresh={refresh} loading={state.loading}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Edit the minimum bid, close early, cancel (refunds the leader, seller not paid) or hide an auction. Hiding only affects this app's UI; it is not enforced on chain.
      </Typography>
      <WriteNotice canWrite={canWrite} />
      <ErrorLine error={state.error} />
      <TextField
        size="small"
        label="Search description or address"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        sx={{ minWidth: 280, mb: 1 }}
      />
      <Typography variant="caption" color="text.secondary" display="block">
        Newest first. {searching ? `${page.total} match${page.total === 1 ? "" : "es"}. ` : `${state.addresses.length} auctions. `}
        {state.progress} Auction payloads are never shown here.
      </Typography>
      <div className="tableScrollWrap">
        <Table size="small">
          <TableHead>
            <TableRow>
              {["Auction", "Status", "Min", "Highest", "Countdown", "Actions"].map((name) => (
                <TableCell key={name} sx={adminHeadCellSx}>{name}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {page.rows.map((row) => {
              const can = getAdminActionAvailability(row, nowSec);
              const disabled = !canWrite || Boolean(busy);
              return (
                <TableRow key={row.address} data-testid={`auction-row-${row.address}`}>
                  <TableCell>
                    <span style={monoSx} title={row.address}>
                      {shortAddress(row.address)}
                    </span>{" "}
                    {row.description}{" "}
                    <Button component={RouterLink} to={`/auction/${row.address}`} size="small">View</Button>
                  </TableCell>
                  <TableCell>
                    <StatusLabel status={can.status} hidden={row.hidden} />
                  </TableCell>
                  <TableCell sx={monoSx}>{row.minimum}</TableCell>
                  <TableCell sx={monoSx}>{row.highestBid}</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    {can.status === "active" ? <Countdown endTime={row.endTime} nowSec={nowSec} /> : "-"}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    <Button size="small" onClick={() => dialogs.openRecord(row.address)}>
                      Record
                    </Button>
                    <Button
                      size="small"
                      disabled={disabled || !can.editMinimum}
                      onClick={() => setPending({ address: row.address, value: row.minimum })}
                    >
                      Edit minimum
                    </Button>
                    <Button
                      size="small"
                      disabled={disabled || !can.closeNow}
                      onClick={() => run("Close now", () => actions.closeNow(row.address))}
                    >
                      Close now
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      disabled={disabled || !can.cancel}
                      onClick={() => dialogs.openCancel(row)}
                    >
                      {can.cancelHidesOnly ? "Cancel (hide only)" : "Cancel"}
                    </Button>
                    <Button
                      size="small"
                      disabled={disabled}
                      onClick={() =>
                        run(row.hidden ? "Unhide" : "Hide", () => actions.setHidden(row.address, !row.hidden))
                      }
                    >
                      {row.hidden ? "Unhide" : "Hide"}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {!page.rows.length && !state.loading ? (
              <TableRow><TableCell colSpan={6}>{searching ? "No auctions match your search." : "No auctions found."}</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      {hasMore ? (
        <Button size="small" variant="outlined" sx={{ mt: 1, borderRadius: "20px" }} onClick={() => setVisible((value) => value + AUCTION_ADMIN_PAGE_SIZE)}>
          Load more
        </Button>
      ) : null}
      {canWrite && pending ? (
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1.5, flexWrap: "wrap" }}>
          <Typography variant="body2">
            New minimum bid for <span style={monoSx}>{shortAddress(pending.address)}</span>:
          </Typography>
          <TextField
            size="small"
            label="Minimum"
            value={pending.value}
            onChange={(event) => setPending((current) => ({ ...current, value: event.target.value }))}
          />
          <Button
            size="small"
            variant="contained"
            sx={adminPrimaryButtonSx}
            disabled={Boolean(busy)}
            onClick={() =>
              run("Edit minimum", async () => {
                await actions.setMinimum(pending.address, pending.value);
                setPending(null);
              })
            }
          >
            Save
          </Button>
          <Button size="small" onClick={() => setPending(null)}>
            Back
          </Button>
        </Box>
      ) : null}
      <ActionMessage message={message} />
      {dialogs.dialogs}
    </AdminCard>
  );
};

// ---- Admins (owner only) and settings ----------------------------------------------------------

export const AdminsCard = ({ isOwner = false, actions: actionsOverride, ownerReader = readFactoryOwner }) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [open, toggle] = useCardState(false);
  const [owner, setOwner] = useState("");
  const [address, setAddress] = useState("");
  const { busy, message, run } = useAdminActionRunner();

  useEffect(() => {
    if (open && isOwner) ownerReader().then(setOwner, () => setOwner(""));
  }, [open, isOwner, ownerReader]);

  if (!isOwner) return null;
  return (
    <AdminCard
      title="Admins"
      open={open}
      onToggle={toggle}
    >
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Only the factory owner can add or remove admins. The owner can never be removed; ownership transfers are 2-step.
      </Typography>
      <Typography variant="body2" sx={monoSx}>
        Owner: {owner || "..."}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1.5, flexWrap: "wrap" }}>
        <TextField
          size="small"
          label="Wallet address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          sx={{ minWidth: 360 }}
        />
        <Button
          size="small"
          variant="contained"
          sx={adminPrimaryButtonSx}
          disabled={Boolean(busy)}
          onClick={() => run("Add admin", () => actions.addAdmin(address))}
        >
          Add admin
        </Button>
        <Button
          size="small"
          color="error"
          disabled={Boolean(busy)}
          onClick={() => run("Remove admin", () => actions.removeAdmin(address))}
        >
          Remove admin
        </Button>
      </Box>
      <ActionMessage message={message} />
    </AdminCard>
  );
};

export const MarketSettingsCard = ({ canWrite = false, actions: actionsOverride, reader }) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [open, toggle] = useCardState(false);
  const [allowSellerEdit, setAllowSellerEdit] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const value = reader
        ? await reader()
        : await readOnlyCall(({ factory }) => factory.methods.allowSellerEdit(), 1, {
            ...READ_OPTIONS,
            factoryAddress: getActiveFactoryAddress(),
          });
      setAllowSellerEdit(Boolean(value));
      setError("");
    } catch (readError) {
      setError(readError?.message || "Could not read settings.");
    }
  }, [reader]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const { busy, message, run } = useAdminActionRunner(load);

  return (
    <AdminCard
      title="Marketplace settings"
      open={open}
      onToggle={toggle}
      onRefresh={load}
    >
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Whether sellers may edit the minimum bid of their own auction while it has no bids.
      </Typography>
      <WriteNotice canWrite={canWrite} />
      <ErrorLine error={error} />
      <FormControlLabel
        control={
          <Checkbox
            checked={Boolean(allowSellerEdit)}
            disabled={!canWrite || allowSellerEdit === null || Boolean(busy)}
            onChange={(event) => run("Seller edits", () => actions.setAllowSellerEdit(event.target.checked))}
          />
        }
        label="Allow sellers to edit the minimum (before the first bid)"
      />
      <ActionMessage message={message} />
    </AdminCard>
  );
};

export const AdminOpsCards = ({ access } = {}) => {
  const canWrite = Boolean(access?.canWrite);
  return (
    <>
      <UsersBudgetsCard canWrite={canWrite} />
      <AuctionControlsCard canWrite={canWrite} />
      <MarketSettingsCard canWrite={canWrite} />
      <AdminsCard isOwner={Boolean(access?.isOwner)} />
      <AuditEventsCard />
      <ArchitectureCard />
      <FaucetCard />
      <AdminGasCards />
    </>
  );
};

export default AdminOpsCards;
