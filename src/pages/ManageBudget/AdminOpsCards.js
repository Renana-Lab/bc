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
import { subscribeToBudgetChanges } from "../../real_ethereum/budget";
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
  inspectEventJson,
  joinUrl,
  mapBotConfig,
  mapUserRows,
  toServiceRow,
} from "./adminCardData";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const PROBE_TIMEOUT_MS = 6000;
const LIVE_FACTORY_EVENTS = ["BudgetChanged", "AuctionCreatedDetailed", "AuctionFinalizationFailed"];

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

export const UsersBudgetsCard = () => {
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
      const budgetPairs = await mapWithConcurrency(users.addresses, 4, async (address) => {
        try {
          return [address.toLowerCase(), String(await readOnlyCall(({ factory }) => factory.methods.usersBudget(address), 1, options))];
        } catch (_) {
          budgetErrors += 1;
          return [address.toLowerCase(), "unavailable"];
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

  const history = state.historyError ? "unavailable" : state.audit?.failedRanges?.length ? "partial" : "ok";
  const historyNote = describeRangeHealth(state.audit || {});

  return (
    <AdminCard
      title="Users and budgets"
      description="Registered wallets from the factory, their current budget and last budget change. Read-only."
      open={open}
      onToggle={toggle}
      onRefresh={() => load(true)}
      loading={state.loading}
    >
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
              <th>Budget</th>
              <th>Last change</th>
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
                  {row.isBot ? <Chip size="small" label="bot" color="secondary" /> : null}
                </td>
                <td style={monoSx}>{row.budget}</td>
                <td style={{ fontSize: 12 }}>
                  {row.lastChange
                    ? `${row.lastChange.direction} ${row.lastChange.amount} at block ${row.lastChange.blockNumber}`
                    : history === "unavailable"
                      ? "budget history unavailable"
                      : `none in last ${state.audit?.lookback ?? getAuditLookbackBlocks()} blocks`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
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

export const AdminOpsCards = () => (
  <>
    <UsersBudgetsCard />
    <AuditEventsCard />
    <ArchitectureCard />
    <FaucetCard />
  </>
);

export default AdminOpsCards;
