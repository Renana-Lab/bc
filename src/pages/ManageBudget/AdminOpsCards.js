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
  Collapse,
  FormControlLabel,
  IconButton,
  Checkbox,
  TextField,
  Typography,
} from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import { readOnlyCall, readOnlyExecute } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress, subscribeToMarketChanges } from "../../real_ethereum/marketConfig";
import { getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import { getConfiguredRpcUrls } from "../../real_ethereum/rpcConfig";
import { canUseLiveEvents, factorySocket } from "../../real_ethereum/socketFactory";
import { notifyBudgetChanged, subscribeToBudgetChanges } from "../../real_ethereum/budget";
import { readCancelledSet, readFactoryOwner, readHiddenSet } from "../../real_ethereum/adminChain";
import { chainNowMs } from "../../real_ethereum/chainClock";
import { createAdminActions } from "./adminActions";
import { subscribeActiveAuctionRegistry } from "../../real_ethereum/activeAuctionRegistry";
import { getLivePresence, isPresenceConfigured } from "../../telemetry/presenceClient";
import { LOCAL_BOTS_KEY } from "../../telemetry/botPresence";
import { mapWithConcurrency, shortAddress } from "./reportUtils";
import { describeRangeHealth } from "../../real_ethereum/chunkedLogs";
import {
  AUDIT_CAMPAIGN_LIMIT,
  getAuditLookbackBlocks,
  getAuditSnapshot,
  readAllUsers,
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
  toServiceRow,
} from "./adminCardData";

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
const AUCTION_ADMIN_LIMIT = 30;

const cardSx = {
  width: "100%",
  mb: 3,
  p: { xs: 1.5, sm: 2 },
  border: "1px solid #d9dff2",
  borderRadius: 3,
  background: "rgba(255,255,255,0.72)",
};

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

const AdminCard = ({ title, description, open, onToggle, onRefresh, loading, children }) => (
  <Box sx={cardSx}>
    <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 2, alignItems: "start" }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6">{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 680 }}>
          {description}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        {onRefresh ? (
          <Button size="small" variant="outlined" onClick={onRefresh} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </Button>
        ) : null}
        <IconButton
          size="small"
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          onClick={onToggle}
          sx={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          <KeyboardArrowDownIcon />
        </IconButton>
      </Box>
    </Box>
    <Collapse in={open} timeout="auto" unmountOnExit>
      <Box sx={{ mt: 2 }}>{children}</Box>
    </Collapse>
  </Box>
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

export const UsersBudgetsCard = ({ canWrite = false, actions: actionsOverride }) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [budgetDraft, setBudgetDraft] = useState({ address: "", value: "" });
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({ rows: [], loading: false, error: "", warnings: [], audit: null, historyError: "" });
  const requestRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const requestId = ++requestRef.current;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const factoryAddress = getActiveFactoryAddress();
      const options = { ...READ_OPTIONS, factoryAddress };
      const users = await readAllUsers((index) =>
        readOnlyCall(({ factory }) => factory.methods.allUsers(index), 1, options)
      );
      let budgetErrors = 0;
      const held = {};
      const disabled = new Set();
      // getBudget applies a pending lazy global reset; usersBudget would show a stale raw value.
      const budgetPairs = await mapWithConcurrency(users.addresses, 4, async (address) => {
        const key = address.toLowerCase();
        try {
          const [budget, heldAmount, isDisabled] = await Promise.all([
            readOnlyCall(({ factory }) => factory.methods.getBudget(address), 1, options),
            readOnlyCall(({ factory }) => factory.methods.heldBy(address), 1, options),
            readOnlyCall(({ factory }) => factory.methods.disabled(address), 1, options),
          ]);
          held[key] = String(heldAmount);
          if (isDisabled) disabled.add(key);
          return [key, String(budget)];
        } catch (_) {
          budgetErrors += 1;
          return [key, "unavailable"];
        }
      });
      // One audit read is shared with the Audit events card.
      let audit = null;
      let historyError = "";
      try {
        audit = await getAuditSnapshot(factoryAddress, { force });
      } catch (auditError) {
        historyError = auditError?.message || "audit read failed";
      }
      const { labels, bots } = readLocalBots();
      const rows = mapUserRows({
        addresses: users.addresses,
        budgets: Object.fromEntries(budgetPairs),
        events: (audit?.events || []).filter((event) => event.name === "BudgetChanged"),
        labels,
        bots,
        held,
        disabled,
      });
      const warnings = [users.warning, budgetErrors ? `${budgetErrors} budget reads failed.` : ""].filter(Boolean);
      if (requestId === requestRef.current) {
        setState({ rows, loading: false, error: "", warnings, audit, historyError });
      }
    } catch (error) {
      if (requestId === requestRef.current) {
        setState((current) => ({ ...current, loading: false, error: error?.message || "Could not read users." }));
      }
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useAdminLiveRefresh(() => open && load(true));
  const { busy, message, run } = useAdminActionRunner(() => load(true));

  const history = state.historyError ? "unavailable" : state.audit?.failedRanges?.length ? "partial" : "ok";
  const historyNote = describeRangeHealth(state.audit || {});

  return (
    <AdminCard
      title="Users and budgets"
      description="Registered wallets from the factory, their available budget, funds held by leading bids and last budget change. Admins can set a user's total budget or disable them."
      open={open}
      onToggle={toggle}
      onRefresh={() => load(true)}
      loading={state.loading}
    >
      <WriteNotice canWrite={canWrite} />
      <Typography variant="caption" color="text.secondary" display="block">
        Disabling blocks creating and bidding for that wallet only; a new wallet bypasses it.
      </Typography>
      <ErrorLine error={state.error} />
      {state.warnings.map((warning) => (
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
        {state.rows.length} users. Newest activity first. Budget changes are read from the last {state.audit?.lookback ?? getAuditLookbackBlocks()} blocks. Labels come from this browser's bot config.
      </Typography>
      <Box sx={{ overflowX: "auto", mt: 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>User</th>
              <th>Available</th>
              <th>Held</th>
              <th>Total</th>
              <th>Last change</th>
              {canWrite ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => (
              <tr key={row.address} style={{ borderTop: "1px solid #e3e7f5" }}>
                <td>
                  <span style={monoSx} title={row.address}>
                    {shortAddress(row.address)}
                  </span>{" "}
                  {row.label ? <strong>{row.label}</strong> : null}{" "}
                  {row.isBot ? <Chip size="small" label="bot" color="secondary" /> : null}{" "}
                  {row.disabled ? <Chip size="small" label="disabled" color="error" /> : null}
                </td>
                <td style={monoSx}>{row.budget}</td>
                <td style={monoSx}>{row.held}</td>
                <td style={monoSx}>{row.total}</td>
                <td style={{ fontSize: 12 }}>
                  {row.lastChange
                    ? `${row.lastChange.direction} ${row.lastChange.amount} at block ${row.lastChange.blockNumber}`
                    : history === "unavailable"
                      ? "budget history unavailable"
                      : `none in last ${state.audit?.lookback ?? getAuditLookbackBlocks()} blocks`}
                </td>
                {canWrite ? (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button
                      size="small"
                      disabled={Boolean(busy)}
                      onClick={() => setBudgetDraft({ address: row.address, value: row.total })}
                    >
                      Set budget
                    </Button>
                    <Button
                      size="small"
                      color={row.disabled ? "primary" : "error"}
                      disabled={Boolean(busy)}
                      onClick={() =>
                        run(row.disabled ? "Enable user" : "Disable user", () => actions.setDisabled(row.address, !row.disabled))
                      }
                    >
                      {row.disabled ? "Enable" : "Disable"}
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
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
      description="Health of the services the experiment depends on. Read-only; no secrets are sent or shown."
      open={open}
      onToggle={toggle}
      onRefresh={load}
      loading={state.loading}
    >
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
      description="Factory and recent campaign events, newest first. Read-only."
      open={open}
      onToggle={toggle}
      onRefresh={() => load(true)}
      loading={state.loading}
    >
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
      description="Test-fund faucet status. The faucet controls live on the faucet admin page."
      open={open}
      onToggle={toggle}
      onRefresh={faucetUrl ? load : undefined}
      loading={state.loading}
    >
      <Button component={RouterLink} to="/admin/faucet" size="small" variant="contained" sx={{ mb: 1.5 }}>
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

const STATUS_COLOR = { live: "success", ended: "warning", finalized: "default", cancelled: "error" };

export const AuctionControlsCard = ({ canWrite = false, actions: actionsOverride, reader }) => {
  const actions = useMemo(() => actionsOverride || createAdminActions(), [actionsOverride]);
  const [open, toggle] = useCardState(false);
  const [state, setState] = useState({ rows: [], loading: false, error: "" });
  const [pending, setPending] = useState(null); // { type: "minimum" | "cancel", address, value }
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const options = { ...READ_OPTIONS, factoryAddress: getActiveFactoryAddress() };
      const rows = reader
        ? await reader()
        : await (async () => {
            const all = await readOnlyCall(({ factory }) => factory.methods.getDeployedCampaigns(), 1, options);
            const recent = [...all].slice(-AUCTION_ADMIN_LIMIT).reverse();
            const summaries = await mapWithConcurrency(recent, 4, async (address) => {
              try {
                return await readOnlyCall(({ campaign }) => campaign(address).methods.getListSummary(), 1, options);
              } catch (_) {
                return null;
              }
            });
            const hidden = await readHiddenSet(recent, { options }).catch(() => new Set());
            const closed = recent.filter((_, index) => summaries[index]?.[8]);
            const cancelled = await readCancelledSet(closed, { options });
            return recent
              .map((address, index) =>
                summaries[index]
                  ? mapAuctionAdminRow({
                      address,
                      summary: summaries[index],
                      cancelled: cancelled.has(address.toLowerCase()),
                      hidden: hidden.has(address.toLowerCase()),
                    })
                  : null
              )
              .filter(Boolean);
          })();
      if (requestId === requestRef.current) setState({ rows, loading: false, error: "" });
    } catch (error) {
      if (requestId === requestRef.current) {
        setState((current) => ({ ...current, loading: false, error: error?.message || "Could not read auctions." }));
      }
    }
  }, [reader]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useAdminLiveRefresh(() => open && load());
  const { busy, message, run } = useAdminActionRunner(load);

  const nowSec = Math.floor(chainNowMs() / 1000);

  return (
    <AdminCard
      title="Auction controls"
      description="Edit the minimum bid, close early, cancel (refunds the leader, seller not paid) or hide an auction. Hidden auctions are only hidden in the UI."
      open={open}
      onToggle={toggle}
      onRefresh={load}
      loading={state.loading}
    >
      <WriteNotice canWrite={canWrite} />
      <ErrorLine error={state.error} />
      <Typography variant="caption" color="text.secondary">
        Newest {AUCTION_ADMIN_LIMIT} auctions. Auction payloads are never shown here.
      </Typography>
      <Box sx={{ overflowX: "auto", mt: 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Auction</th>
              <th>Status</th>
              <th>Min</th>
              <th>Highest</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => {
              const can = getAdminActionAvailability(row, nowSec);
              const disabled = !canWrite || Boolean(busy);
              return (
                <tr key={row.address} style={{ borderTop: "1px solid #e3e7f5" }} data-testid={`auction-row-${row.address}`}>
                  <td>
                    <span style={monoSx} title={row.address}>
                      {shortAddress(row.address)}
                    </span>{" "}
                    {row.description}
                  </td>
                  <td>
                    <Chip size="small" label={can.status} color={STATUS_COLOR[can.status]} />{" "}
                    {row.hidden ? <Chip size="small" label="hidden" variant="outlined" /> : null}
                  </td>
                  <td style={monoSx}>{row.minimum}</td>
                  <td style={monoSx}>{row.highestBid}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button
                      size="small"
                      disabled={disabled || !can.editMinimum}
                      onClick={() => setPending({ type: "minimum", address: row.address, value: row.minimum })}
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
                      onClick={() => setPending({ type: "cancel", address: row.address, value: "" })}
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Box>
      {canWrite && pending ? (
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1.5, flexWrap: "wrap" }}>
          <Typography variant="body2">
            {pending.type === "minimum" ? "New minimum bid" : "Cancellation note (optional, max 500 bytes)"} for{" "}
            <span style={monoSx}>{shortAddress(pending.address)}</span>:
          </Typography>
          <TextField
            size="small"
            label={pending.type === "minimum" ? "Minimum" : "Note"}
            value={pending.value}
            onChange={(event) => setPending((current) => ({ ...current, value: event.target.value }))}
          />
          <Button
            size="small"
            variant="contained"
            color={pending.type === "cancel" ? "error" : "primary"}
            disabled={Boolean(busy)}
            onClick={() =>
              run(pending.type === "minimum" ? "Edit minimum" : "Cancel auction", async () => {
                if (pending.type === "minimum") await actions.setMinimum(pending.address, pending.value);
                else await actions.cancelAuction(pending.address, pending.value);
                setPending(null);
              })
            }
          >
            {pending.type === "minimum" ? "Save" : "Confirm cancel"}
          </Button>
          <Button size="small" onClick={() => setPending(null)}>
            Back
          </Button>
        </Box>
      ) : null}
      <ActionMessage message={message} />
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
      description="Only the factory owner can add or remove admins. The owner can never be removed; ownership transfers are 2-step."
      open={open}
      onToggle={toggle}
    >
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
      description="Whether sellers may edit the minimum bid of their own auction while it has no bids."
      open={open}
      onToggle={toggle}
      onRefresh={load}
    >
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
    </>
  );
};

export default AdminOpsCards;
