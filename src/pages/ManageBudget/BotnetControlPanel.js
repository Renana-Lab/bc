import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import toast from "react-hot-toast";
import Web3 from "web3";
import CampaignFactory from "../../real_ethereum/build/CampaignFactory.json";
import Campaign from "../../real_ethereum/build/Campaign.json";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import {
  acquireActiveAuctionCoordinatorLease,
  getActiveAuctionSnapshot,
  markAuctionClosed,
  publishActiveAuctions,
  refreshActiveAuctionRegistry,
  releaseActiveAuctionCoordinatorLease,
  subscribeActiveAuctionRegistry,
} from "../../real_ethereum/activeAuctionRegistry";
import {
  executeWithRpcFailover,
  getConfiguredRpcUrls,
  getFriendlyRpcError,
  getRpcErrorMessage,
  getRpcFailureKind,
  isRpcProviderFailure,
  markRpcProviderFailure,
  resetRpcProviderHealth,
} from "../../real_ethereum/rpcConfig";
import {
  BOTNET_STATE_EVENT,
  LOCAL_BOTS_KEY,
  LOCAL_LOGS_KEY,
  LOCAL_OBSERVATORY_KEY,
} from "../../telemetry/botPresence";
import {
  allocateCycleCandidates,
  clampBidsPerCycle,
  createEmptyCycleMetrics,
  finishCycleMetrics,
  getActivityUsage,
  getBidDecision as getSharedBidDecision,
} from "../../botnet/cyclePlanner.mjs";
import { BOT_SCHEDULER_TICK_EVENT } from "../../botnet/runtimeEvents";

const activeBotCycles = new Set();
export const PRIVATE_KEY_WALLET = "private-key";
export const METAMASK_AGENT_WALLET = "metamask-agent";
const RPC_URLS = getConfiguredRpcUrls();
const BOT_MAX_BOTS_PER_TICK = Math.max(
  1,
  Number(process.env.REACT_APP_BOT_MAX_BOTS_PER_TICK || 6)
);
const BOT_START_STAGGER_MS = Math.max(
  0,
  Number(process.env.REACT_APP_BOT_START_STAGGER_MS || 120)
);
const BOT_RPC_RATE_LIMIT_COOLDOWN_MS = Math.max(
  5000,
  Number(process.env.REACT_APP_BOT_RPC_RATE_LIMIT_COOLDOWN_MS || 45000)
);
const BOT_CYCLE_STALE_MS = Math.max(
  30000,
  Number(process.env.REACT_APP_BOT_CYCLE_STALE_MS || 180000)
);
const BOT_SCHEDULER_TICK_MS = Math.max(
  2500,
  Number(process.env.REACT_APP_BOT_SCHEDULER_TICK_MS || 5000)
);
const BOT_MAX_CONCURRENT_WRITES = Math.max(
  1,
  Number(process.env.REACT_APP_BOT_MAX_CONCURRENT_WRITES || 3)
);
const BOT_FINALIZE_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.REACT_APP_BOT_FINALIZE_INTERVAL_MS || 30000),
);
const BOT_STALE_SNAPSHOT_MAX_MS = Math.max(
  30000,
  Number(process.env.REACT_APP_BOT_STALE_SNAPSHOT_MAX_MS || 120000),
);
const OBSERVATORY_ROUND_LIMIT = 30;

const DEFAULT_OVERRIDES = {
  MAX_BID_WEI: "2000",
  OUTBID_BY_WEI: "10",
  MAX_MIN_CONTRIBUTION_WEI: "2000",
  MIN_TIME_REMAINING_SEC: "20",
  AUTO_TRADE_INTERVAL_SEC: "60",
  MAX_BIDS_PER_CYCLE: "1",
  ENABLE_BIDDING: "true",
  ENABLE_FINALIZE: "true",
  SKIP_IF_WINNING: "true",
};

const emptyBotForm = {
  name: "",
  privateKey: "",
  enabled: true,
  maxBidWei: "",
  intervalSec: "60",
  maxBidsPerCycle: "1",
  enableBidding: true,
  enableFinalize: true,
};

const web3ForKeys = new Web3();
const browserWeb3Cache = new Map();
const browserFactoryCache = new Map();
const browserCampaignCache = new Map();
const browserAccountCache = new Map();

const getCachedWeb3 = (rpcUrl) => {
  if (!browserWeb3Cache.has(rpcUrl)) {
    browserWeb3Cache.set(
      rpcUrl,
      new Web3(
        new Web3.providers.HttpProvider(rpcUrl, {
          timeout: Number(process.env.REACT_APP_RPC_TIMEOUT_MS || 9000),
        }),
      ),
    );
  }
  return browserWeb3Cache.get(rpcUrl);
};

const getCachedFactory = (web3, rpcUrl, factoryAddress) => {
  const key = `${rpcUrl}:${String(factoryAddress).toLowerCase()}`;
  if (!browserFactoryCache.has(key)) {
    browserFactoryCache.set(key, new web3.eth.Contract(CampaignFactory.abi, factoryAddress));
  }
  return browserFactoryCache.get(key);
};

const getCachedCampaign = (web3, rpcUrl, address) => {
  const key = `${rpcUrl}:${String(address).toLowerCase()}`;
  if (!browserCampaignCache.has(key)) {
    browserCampaignCache.set(key, new web3.eth.Contract(Campaign.abi, address));
  }
  return browserCampaignCache.get(key);
};

const getCachedAccount = (web3, privateKey) => {
  const normalizedKey = normalizePrivateKey(privateKey);
  const cacheKey = normalizedKey.toLowerCase();
  if (!browserAccountCache.has(cacheKey)) {
    browserAccountCache.set(cacheKey, web3.eth.accounts.privateKeyToAccount(normalizedKey));
  }
  const account = browserAccountCache.get(cacheKey);
  if (!web3.eth.accounts.wallet[account.address]) web3.eth.accounts.wallet.add(account);
  return account;
};

const executeBatchCalls = (web3, calls, blockNumber = "latest") => {
  if (!calls.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const batch = new web3.BatchRequest();
    const results = new Array(calls.length);
    let remaining = calls.length;
    calls.forEach((method, index) => {
      const callback = (error, value) => {
        results[index] = error
          ? { status: "rejected", reason: error }
          : { status: "fulfilled", value };
        remaining -= 1;
        if (!remaining) resolve(results);
      };
      batch.add(method.call.request({}, blockNumber, callback));
    });
    try {
      batch.execute();
    } catch (error) {
      reject(error);
    }
  });
};

const createSemaphore = (limit) => {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
};

const withBrowserWriteSlot = createSemaphore(BOT_MAX_CONCURRENT_WRITES);

const sleep = (ms) =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const getErrorMessage = getRpcErrorMessage;

const readJson = (key, fallback) => {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
};

const writeJson = (key, value) => {
  window.localStorage.setItem(key, JSON.stringify(value));
};

export const normalizePrivateKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("0x") ? raw : `0x${raw}`;
};

export const isValidPrivateKey = (value) => /^0x[a-fA-F0-9]{64}$/.test(normalizePrivateKey(value));

export const isMetaMaskAgentBot = (bot) => bot?.walletType === METAMASK_AGENT_WALLET;

export const isBrowserRunnableBot = (bot) =>
  !isMetaMaskAgentBot(bot) && isValidPrivateKey(bot?.privateKey);

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
};

const toBigIntSafe = (value, fallback = 0n) => {
  try {
    if (typeof value === "bigint") return value;
    if (value && typeof value.toString === "function") {
      return window.BigInt(value.toString());
    }
    return window.BigInt(value || "0");
  } catch (_) {
    return fallback;
  }
};

const createBotId = (name = "bot") => {
  const slug =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 18) || "bot";
  return `${slug}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
};

const getWalletAddress = (privateKey) => {
  if (!isValidPrivateKey(privateKey)) return "";
  try {
    return web3ForKeys.eth.accounts.privateKeyToAccount(normalizePrivateKey(privateKey)).address;
  } catch (_) {
    return "";
  }
};

export const normalizeBot = (bot = {}) => {
  const privateKey = normalizePrivateKey(bot.privateKey);
  const walletType = isMetaMaskAgentBot(bot) ? METAMASK_AGENT_WALLET : PRIVATE_KEY_WALLET;
  const agentWallet = walletType === METAMASK_AGENT_WALLET;
  const validPrivateKey = isValidPrivateKey(privateKey);
  const configured = agentWallet || validPrivateKey;
  const storedLastError = bot.lastError || null;
  const normalizedLastError =
    storedLastError && isRpcProviderFailure(storedLastError)
      ? getFriendlyRpcError(storedLastError)
      : storedLastError;
  const cycleStartedAt = bot.lastCycleAt ? new Date(bot.lastCycleAt).getTime() : 0;
  const staleRunningCycle =
    bot.status === "running-cycle" &&
    cycleStartedAt &&
    Date.now() - cycleStartedAt > BOT_CYCLE_STALE_MS;
  return {
    id: bot.id || createBotId(bot.name),
    name: String(bot.name || "Bot").trim(),
    walletType,
    privateKey,
    wallet: agentWallet ? String(bot.wallet || "") : getWalletAddress(privateKey),
    enabled: configured && toBool(bot.enabled, true),
    running: agentWallet ? false : Boolean(bot.running),
    status: agentWallet
      ? "runner-managed"
      : validPrivateKey
      ? staleRunningCycle
        ? bot.running
          ? "running"
          : "stopped"
        : bot.status || "stopped"
      : "invalid-config",
    lastCycleAt: bot.lastCycleAt || null,
    lastError: agentWallet
      ? null
      : validPrivateKey
      ? staleRunningCycle
        ? "Previous cycle was interrupted and recovered by the local scheduler."
        : normalizedLastError
      : "Private key is missing or invalid.",
    stats: {
      cycles: Number(bot.stats?.cycles || 0),
      bids: Number(bot.stats?.bids || 0),
      finalized: Number(bot.stats?.finalized || 0),
      errors: Number(bot.stats?.errors || 0),
    },
    lastCycleMetrics: bot.lastCycleMetrics || null,
    overrides: {
      ...DEFAULT_OVERRIDES,
      ...(bot.overrides || {}),
    },
    createdAt: bot.createdAt || new Date().toISOString(),
    updatedAt: bot.updatedAt || new Date().toISOString(),
  };
};

export const ensureSingleMetaMaskAgentBot = (bots = []) => {
  const normalized = bots.map(normalizeBot);
  if (normalized.length < 4) return normalized;

  const existingAgentIndex = normalized.findIndex(isMetaMaskAgentBot);
  const agentIndex = existingAgentIndex >= 0 ? existingAgentIndex : 3;
  return normalized.map((bot, index) => {
    if (index === agentIndex) {
      return normalizeBot({
        ...bot,
        name: existingAgentIndex >= 0 ? bot.name : "MetaMask Wallet Agent",
        walletType: METAMASK_AGENT_WALLET,
        running: false,
        status: "runner-managed",
        lastError: null,
      });
    }
    if (!isMetaMaskAgentBot(bot)) return bot;
    return normalizeBot({ ...bot, walletType: PRIVATE_KEY_WALLET });
  });
};

const notifyBotnetStateChanged = () => {
  window.setTimeout(() => {
    window.dispatchEvent(new Event(BOTNET_STATE_EVENT));
  }, 0);
};

const loadStoredBots = () => ensureSingleMetaMaskAgentBot(readJson(LOCAL_BOTS_KEY, []));
const saveStoredBots = (bots) => {
  writeJson(LOCAL_BOTS_KEY, ensureSingleMetaMaskAgentBot(bots));
  notifyBotnetStateChanged();
};
const isLegacyProviderNoise = (entry) =>
  Boolean(entry?.meta?.provider && entry?.meta?.failureKind) &&
  /rpc endpoint|rpc capacity|temporarily unreachable|cooling down/i.test(
    String(entry?.message || ""),
  );

const loadStoredLogs = () =>
  readJson(LOCAL_LOGS_KEY, []).filter((entry) => !isLegacyProviderNoise(entry));
const saveStoredLogs = (logs) => {
  writeJson(LOCAL_LOGS_KEY, logs.slice(0, 120));
  notifyBotnetStateChanged();
};

export const normalizeObservatoryRounds = (rounds = []) => {
  const seen = new Set();
  return (Array.isArray(rounds) ? rounds : [])
    .filter((round) => round && typeof round === "object" && round.id)
    .filter((round) => {
      if (seen.has(round.id)) return false;
      seen.add(round.id);
      return true;
    })
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
    .slice(0, OBSERVATORY_ROUND_LIMIT);
};

const loadStoredObservatoryRounds = () =>
  normalizeObservatoryRounds(readJson(LOCAL_OBSERVATORY_KEY, []));

const saveStoredObservatoryRounds = (rounds) => {
  const normalized = normalizeObservatoryRounds(rounds);
  writeJson(LOCAL_OBSERVATORY_KEY, normalized);
  notifyBotnetStateChanged();
  return normalized;
};

const appendStoredObservatoryRound = (round) =>
  saveStoredObservatoryRounds([
    round,
    ...loadStoredObservatoryRounds().filter((item) => item.id !== round.id),
  ]);

const createLog = (level, message, meta = {}) => ({
  time: new Date().toISOString(),
  level,
  message,
  meta,
});

const shortAddress = (value) => {
  const text = String(value || "");
  if (!text) return "wallet not loaded";
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
};

const shortKey = (value) => {
  const key = normalizePrivateKey(value);
  if (!key) return "no private key";
  return `${key.slice(0, 10)}...${key.slice(-8)}`;
};

const formatDate = (value) => {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
};

export const formatAuctionCountdown = (endTimeSec, nowMs = Date.now()) => {
  const remaining = Math.max(0, Number(endTimeSec || 0) - Math.floor(nowMs / 1000));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const getRegistryDisplayRows = (snapshot = {}) => [
  ...(snapshot.activeAuctions || []).map((auction) => ({ ...auction, registryState: "active" })),
  ...(snapshot.finalizableAuctions || []).map((auction) => ({
    ...auction,
    registryState: "awaiting-finalization",
  })),
];

export const getUsableCachedAuctionSnapshot = (
  snapshot,
  nowMs = Date.now(),
  maxAgeMs = BOT_STALE_SNAPSHOT_MAX_MS,
) => {
  if (!snapshot?.updatedAt) return null;
  const ageMs = Math.max(0, Number(nowMs) - Number(snapshot.updatedAt));
  return ageMs <= Number(maxAgeMs) ? { snapshot, ageMs } : null;
};

const getBotStatusColor = (status) => {
  if (status === "running") return "#0f7a46";
  if (status === "crashed" || status === "error") return "#b3261e";
  if (status === "running-cycle") return "#7c5c00";
  if (status === "invalid-config") return "#9a3412";
  if (status === "runner-managed") return "#3155a6";
  return "#5f6680";
};

export const extractPrivateKeysFromText = (text = "") => {
  const keys = [
    ...String(text).matchAll(
      /(?:^|[^a-fA-F0-9])((?:0x)?[a-fA-F0-9]{64})(?=$|[^a-fA-F0-9])/g
    ),
  ].map((match) => normalizePrivateKey(match[1]));
  const seen = new Set();
  return keys.filter((key) => {
    const normalized = key.toLowerCase();
    if (!isValidPrivateKey(key) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

export const getStrategy = (bot) => {
  const overrides = bot.overrides || {};
  return {
    maxBidWei: toBigIntSafe(overrides.MAX_BID_WEI || DEFAULT_OVERRIDES.MAX_BID_WEI),
    outbidByWei: toBigIntSafe(overrides.OUTBID_BY_WEI || DEFAULT_OVERRIDES.OUTBID_BY_WEI),
    maxMinContributionWei: toBigIntSafe(
      overrides.MAX_MIN_CONTRIBUTION_WEI || DEFAULT_OVERRIDES.MAX_MIN_CONTRIBUTION_WEI
    ),
    minTimeRemainingSec: toPositiveInt(
      overrides.MIN_TIME_REMAINING_SEC,
      Number(DEFAULT_OVERRIDES.MIN_TIME_REMAINING_SEC)
    ),
    intervalSec: toPositiveInt(
      overrides.AUTO_TRADE_INTERVAL_SEC,
      Number(DEFAULT_OVERRIDES.AUTO_TRADE_INTERVAL_SEC)
    ),
    maxBidsPerCycle: clampBidsPerCycle(
      overrides.MAX_BIDS_PER_CYCLE || DEFAULT_OVERRIDES.MAX_BIDS_PER_CYCLE,
    ),
    enableBidding: toBool(overrides.ENABLE_BIDDING, true),
    enableFinalize: toBool(overrides.ENABLE_FINALIZE, true),
    skipIfWinning: toBool(overrides.SKIP_IF_WINNING, true),
  };
};

const BotMetric = ({ label, value, tone = "#173b91" }) => (
  <Box sx={{ minWidth: 0 }}>
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: "block", lineHeight: 1.15 }}
    >
      {label}
    </Typography>
    <Typography
      variant="body2"
      sx={{ mt: 0.3, color: tone, fontWeight: 800, lineHeight: 1.2, overflowWrap: "anywhere" }}
    >
      {value}
    </Typography>
  </Box>
);

const BotCard = ({
  bot,
  isBusy,
  onBidLimitChange,
  onStart,
  onRun,
  onStop,
  onDelete,
  onClearError,
}) => {
  const [errorOpen, setErrorOpen] = useState(false);
  const strategy = getStrategy(bot);
  const activity = getActivityUsage(strategy.intervalSec, strategy.maxBidsPerCycle);
  const stats = bot.stats || {};
  const agentManaged = isMetaMaskAgentBot(bot);
  const activityTone =
    activity.level === "high"
      ? { color: "#9a3412", backgroundColor: "#fff2e8" }
      : activity.level === "moderate"
        ? { color: "#7c5c00", backgroundColor: "#fff8dd" }
        : { color: "#0f6d45", backgroundColor: "#eaf8f1" };

  return (
    <Box
      sx={{
        borderRadius: 2,
        border: "1px solid #dce4f7",
        background: "linear-gradient(145deg, rgba(255,255,255,0.98), rgba(247,249,255,0.92))",
        boxShadow: "0 5px 16px rgba(24, 52, 121, 0.045)",
        overflow: "hidden",
        transition: "border-color 120ms ease, box-shadow 120ms ease",
        "&:hover": {
          borderColor: "#c9d5f2",
          boxShadow: "0 7px 18px rgba(24, 52, 121, 0.07)",
        },
      }}
    >
      <Box sx={{ p: { xs: 1.5, sm: 1.75 } }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1.25,
            flexWrap: "wrap",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.7, flexWrap: "wrap", minWidth: 0 }}>
            <Typography variant="body1" sx={{ mr: 0.15, fontWeight: 800 }}>
              {bot.name}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                px: 1,
                py: 0.25,
                borderRadius: 999,
                color: "#ffffff",
                backgroundColor: getBotStatusColor(bot.status),
                fontWeight: 800,
                lineHeight: 1.4,
              }}
            >
              {bot.status || "stopped"}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                px: 1,
                py: 0.25,
                borderRadius: 999,
                backgroundColor: bot.enabled ? "#e9f8ef" : "#f1f3f9",
                color: bot.enabled ? "#0f7a46" : "#5f6680",
                fontWeight: 800,
                lineHeight: 1.4,
              }}
            >
              {bot.enabled ? "enabled" : "disabled"}
            </Typography>
            {agentManaged && (
              <Typography
                variant="caption"
                sx={{
                  px: 1,
                  py: 0.25,
                  borderRadius: 999,
                  backgroundColor: "#e9efff",
                  color: "#173b91",
                  fontWeight: 800,
                  lineHeight: 1.4,
                }}
              >
                MetaMask Agent Wallet
              </Typography>
            )}
          </Box>

          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
            <Button size="small" variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={() => onStart(bot.id)} disabled={isBusy || agentManaged} sx={{ borderRadius: 999, backgroundColor: "#103090" }}>
              Start
            </Button>
            <Button size="small" variant="outlined" onClick={() => onRun(bot.id)} disabled={isBusy || agentManaged} sx={{ borderRadius: 999 }}>
              Run
            </Button>
            <Button size="small" variant="outlined" color="error" startIcon={<StopRoundedIcon />} onClick={() => onStop(bot.id)} disabled={isBusy || agentManaged} sx={{ borderRadius: 999 }}>
              Stop
            </Button>
            <Tooltip title="Delete bot">
              <span>
                <IconButton size="small" color="error" onClick={() => onDelete(bot.id)} disabled={isBusy} aria-label={`Delete ${bot.name}`}>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1, overflowWrap: "anywhere" }}>
          {shortAddress(bot.wallet)} &nbsp;|&nbsp; {agentManaged ? "Runner-managed session" : shortKey(bot.privateKey)} &nbsp;|&nbsp; Last cycle {formatDate(bot.lastCycleAt)}
        </Typography>

        <Box
          sx={{
            mt: 1.25,
            p: 1.25,
            display: "grid",
            gridTemplateColumns: {
              xs: "repeat(2, minmax(0, 1fr))",
              sm: "repeat(4, minmax(0, 1fr)) minmax(145px, 1.25fr)",
            },
            gap: 1.25,
            alignItems: "center",
            borderRadius: 1.5,
            backgroundColor: "rgba(239, 243, 253, 0.56)",
          }}
        >
            <BotMetric label="Cycles" value={stats.cycles || 0} />
            <BotMetric label="Bids" value={stats.bids || 0} tone="#5c6fc7" />
            <BotMetric label="Finalized" value={stats.finalized || 0} tone="#168052" />
            <BotMetric
              label="Errors"
              value={stats.errors || 0}
              tone={stats.errors ? "#c2413a" : "#9aa3bd"}
            />
          <Box sx={{ gridColumn: { xs: "1 / -1", sm: "auto" }, minWidth: 0 }}>
            <TextField
              label="Bids / cycle"
              size="small"
              type="number"
              value={strategy.maxBidsPerCycle}
              inputProps={{ min: 1, max: 5, step: 1 }}
              onChange={(event) => onBidLimitChange(bot.id, event.target.value)}
              fullWidth
            />
            <Typography variant="caption" sx={{ display: "block", mt: 0.45, ...activityTone, backgroundColor: "transparent" }}>
              {activity.level} / {activity.writesPerHour}/hour max
            </Typography>
          </Box>
        </Box>

        {agentManaged && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.9 }}>
            Lifecycle controls are managed by the Node runner.
          </Typography>
        )}

        {bot.lastError && (
          <Box sx={{ mt: 1.15, border: "1px solid #f0c8c5", borderRadius: 1.5, backgroundColor: "#fffafa", overflow: "hidden" }}>
            <Box sx={{ px: 1.15, py: 0.75, display: "flex", alignItems: "center", gap: 0.8 }}>
              <ErrorOutlineRoundedIcon sx={{ color: "#b42318", fontSize: 18, flex: "0 0 auto" }} />
              <Typography variant="caption" sx={{ color: "#8f1d16", fontWeight: 700, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {bot.lastError}
              </Typography>
              <Button size="small" onClick={() => setErrorOpen((current) => !current)} sx={{ minWidth: 0, px: 0.8 }}>
                {errorOpen ? "Less" : "Inspect"}
              </Button>
              {!agentManaged && (
                <Tooltip title="Run this bot once again">
                  <span>
                    <IconButton size="small" onClick={() => onRun(bot.id)} disabled={isBusy} aria-label={`Retry ${bot.name}`}>
                      <ReplayRoundedIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              <Tooltip title="Dismiss stored error">
                <IconButton size="small" onClick={() => onClearError(bot.id)} aria-label={`Dismiss ${bot.name} error`}>
                  <DeleteSweepRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
            <Collapse in={errorOpen} timeout={90} unmountOnExit>
              <Typography variant="caption" component="pre" sx={{ m: 0, px: 1.25, pb: 1.1, color: "#6f2420", fontFamily: "monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {bot.lastError}
              </Typography>
            </Collapse>
          </Box>
        )}
      </Box>

    </Box>
  );
};

const BotLogEntry = ({ entry, onRetryProviders }) => {
  const [open, setOpen] = useState(false);
  const level = String(entry.level || "info").toLowerCase();
  const tone =
    level === "error"
      ? { color: "#a52820", background: "#fff8f7", border: "#f0cfcc", icon: <ErrorOutlineRoundedIcon /> }
      : level === "warn"
        ? { color: "#8a5b00", background: "#fffbf2", border: "#eedfb7", icon: <WarningAmberRoundedIcon /> }
        : { color: "#34528e", background: "#f8faff", border: "#dfe6f7", icon: <InfoOutlinedIcon /> };
  const meta = entry.meta && typeof entry.meta === "object" ? entry.meta : {};
  const hasMeta = Object.keys(meta).length > 0;
  const canRetryProvider = Boolean(meta.provider || meta.failureKind);

  return (
    <Box sx={{ border: `1px solid ${tone.border}`, borderRadius: 1.5, backgroundColor: tone.background, overflow: "hidden" }}>
      <Box sx={{ px: 1.1, py: 0.8, display: "grid", gridTemplateColumns: "20px minmax(0, 1fr) auto", gap: 0.8, alignItems: "center" }}>
        <Box sx={{ color: tone.color, display: "flex", "& svg": { fontSize: 17 } }}>{tone.icon}</Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ display: "block", color: tone.color, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {entry.message}
          </Typography>
          <Typography variant="caption" color="text.secondary">{formatDate(entry.time)}</Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.2 }}>
          {canRetryProvider && (
            <Tooltip title="Clear provider cooldowns and retry on the next cycle">
              <IconButton size="small" onClick={onRetryProviders} aria-label="Retry RPC providers">
                <ReplayRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {hasMeta && (
            <IconButton size="small" onClick={() => setOpen((current) => !current)} aria-label={open ? "Collapse log details" : "Inspect log details"}>
              <KeyboardArrowDownRoundedIcon fontSize="small" sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 90ms ease" }} />
            </IconButton>
          )}
        </Box>
      </Box>
      <Collapse in={open} timeout={90} unmountOnExit>
        <Box component="dl" sx={{ m: 0, px: 1.1, pb: 1, display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "4px 10px" }}>
          {Object.entries(meta).map(([key, value]) => (
            <Box component="div" key={key} sx={{ display: "contents" }}>
              <Typography component="dt" variant="caption" color="text.secondary">{key}</Typography>
              <Typography component="dd" variant="caption" sx={{ m: 0, fontFamily: "monospace", overflowWrap: "anywhere" }}>
                {typeof value === "string" ? value : JSON.stringify(value)}
              </Typography>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};

const RegistryMetric = ({ label, value, tone = "#173b91" }) => (
  <Box sx={{ minWidth: 0 }}>
    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
      {label}
    </Typography>
    <Typography variant="body2" sx={{ color: tone, fontWeight: 800, overflowWrap: "anywhere" }}>
      {value}
    </Typography>
  </Box>
);

const DynamicAuctionIndex = ({
  snapshot,
  nowMs,
  open,
  onToggle,
  onRefresh,
  refreshing,
}) => {
  const rows = getRegistryDisplayRows(snapshot);
  const activeCount = snapshot?.activeAuctions?.length || 0;
  const finalizableCount = snapshot?.finalizableAuctions?.length || 0;
  const snapshotAgeMs = snapshot?.updatedAt
    ? Math.max(0, nowMs - Number(snapshot.updatedAt))
    : null;
  const stale = snapshotAgeMs === null || snapshotAgeMs > 30000;

  return (
    <Box
      sx={{
        border: "1px solid #dfe6f7",
        borderRadius: 2,
        background: "linear-gradient(145deg, #ffffff, #f8faff)",
        boxShadow: "0 5px 16px rgba(24, 52, 121, 0.04)",
        overflow: "hidden",
      }}
    >
      <Box sx={{ px: 1.5, py: 1.25, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 1, alignItems: "center" }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
            <Typography variant="body2" sx={{ fontWeight: 800 }}>Dynamic auction list</Typography>
            <Typography
              variant="caption"
              sx={{
                px: 0.85,
                py: 0.2,
                borderRadius: 999,
                color: stale ? "#8a5b00" : "#0f6d45",
                backgroundColor: stale ? "#fff7df" : "#eaf8f1",
                fontWeight: 800,
              }}
            >
              {stale ? "stale" : "up to date"}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.35 }}>
            The exact shared index used by coordinated browser bot cycles. It updates on creation, closure, finalization, and registry refresh.
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
          <Tooltip title="Force one registry refresh">
            <span>
              <IconButton size="small" onClick={onRefresh} disabled={refreshing} aria-label="Refresh dynamic auction list">
                {refreshing ? <CircularProgress size={17} /> : <ReplayRoundedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={onToggle} aria-label={open ? "Collapse dynamic auction list" : "Expand dynamic auction list"}>
            <KeyboardArrowDownRoundedIcon fontSize="small" sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 90ms ease" }} />
          </IconButton>
        </Box>
      </Box>

      <Box sx={{ px: 1.5, pb: 1.25, display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(5, minmax(0, 1fr))" }, gap: 1 }}>
        <RegistryMetric label="Active" value={activeCount} tone="#168052" />
        <RegistryMetric label="Awaiting finalization" value={finalizableCount} tone="#9a6411" />
        <RegistryMetric label="Known contracts" value={snapshot?.knownAddressCount || rows.length} />
        <RegistryMetric label="Unreadable" value={snapshot?.unreadableCount || 0} tone={snapshot?.unreadableCount ? "#b42318" : "#8a94af"} />
        <RegistryMetric label="Snapshot age" value={snapshotAgeMs === null ? "Not loaded" : `${Math.round(snapshotAgeMs / 1000)}s`} tone={stale ? "#8a5b00" : "#64739f"} />
      </Box>

      <Collapse in={open} timeout={90} unmountOnExit>
        <Divider sx={{ borderColor: "#e6ebf7" }} />
        <Box sx={{ px: 1.5, py: 1.15 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, overflowWrap: "anywhere" }}>
            Source {snapshot?.source || "not loaded"} / mode {snapshot?.discoveryMode || "unknown"} / event cursor {snapshot?.eventCursor || 0} / updated {formatDate(snapshot?.updatedAt)}
          </Typography>
          {rows.length ? (
            <Box sx={{ display: "grid", gap: 0.65, maxHeight: 360, overflowY: "auto", overflowX: "hidden", pr: 0.35 }}>
              {rows.map((auction) => {
                const active = auction.registryState === "active";
                return (
                  <Box
                    key={`${auction.registryState}-${auction.address}`}
                    sx={{
                      px: 1.1,
                      py: 0.9,
                      display: "grid",
                      gridTemplateColumns: { xs: "1fr auto", md: "minmax(170px, 1.5fr) repeat(5, minmax(80px, 0.7fr))" },
                      gap: 1,
                      alignItems: "center",
                      border: "1px solid #e5eaf7",
                      borderRadius: 1.5,
                      backgroundColor: "rgba(255,255,255,0.72)",
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Tooltip title={auction.address || "Unknown auction"}>
                        <Typography
                          component="a"
                          href={auction.address ? `https://sepolia.etherscan.io/address/${auction.address}` : undefined}
                          target="_blank"
                          rel="noreferrer"
                          variant="caption"
                          sx={{ color: "#173b91", fontWeight: 800, textDecoration: "none", overflowWrap: "anywhere" }}
                        >
                          {shortAddress(auction.address)}
                        </Typography>
                      </Tooltip>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                        Seller {shortAddress(auction.manager)}
                      </Typography>
                    </Box>
                    <Typography variant="caption" sx={{ justifySelf: "end", px: 0.85, py: 0.2, borderRadius: 999, color: active ? "#0f6d45" : "#8a5b00", backgroundColor: active ? "#eaf8f1" : "#fff7df", fontWeight: 800 }}>
                      {active ? "Active" : "Finalize"}
                    </Typography>
                    <BotMetric label={active ? "Time remaining" : "Ended"} value={active ? formatAuctionCountdown(auction.endTimeSec, nowMs) : formatDate(Number(auction.endTimeSec || 0) * 1000)} tone={active ? "#d97724" : "#64739f"} />
                    <BotMetric label="Minimum" value={`${auction.minimumContribution || 0} wei`} tone="#64739f" />
                    <BotMetric label="Highest bid" value={`${auction.highestBid || 0} wei`} tone="#64739f" />
                    <BotMetric label="Bidders" value={auction.approversCount || 0} tone="#64739f" />
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Box sx={{ py: 2.5, textAlign: "center" }}>
              <Typography variant="body2" color="text.secondary">No active or awaiting-finalization auctions are in the shared index.</Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

const ObservatoryRound = ({ round }) => {
  const [open, setOpen] = useState(false);
  const bots = Array.isArray(round.bots) ? round.bots : [];
  const bidsSent = bots.reduce((total, bot) => total + Number(bot.metrics?.bidsSent || 0), 0);
  const failures = (round.error ? 1 : 0) + bots.reduce(
    (total, bot) => total + (bot.steps || []).filter((step) => step.outcome === "error").length,
    0,
  );

  return (
    <Box sx={{ border: "1px solid #e2e8f6", borderRadius: 1.5, backgroundColor: "rgba(255,255,255,0.76)", overflow: "hidden" }}>
      <Button
        fullWidth
        onClick={() => setOpen((current) => !current)}
        endIcon={<KeyboardArrowDownRoundedIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 90ms ease" }} />}
        sx={{ px: 1.2, py: 0.85, borderRadius: 0, justifyContent: "space-between", color: "#263762", textTransform: "none", textAlign: "left" }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ display: "block", fontWeight: 800 }}>
            {formatDate(round.startedAt)} / {round.status || "completed"}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            {bots.length} bots / {round.snapshot?.activeAuctions || 0} active / {bidsSent} sent / {failures} failures / {Math.max(0, Number(round.finishedAt || round.startedAt) - Number(round.startedAt || 0))} ms
          </Typography>
        </Box>
      </Button>
      <Collapse in={open} timeout={90} unmountOnExit>
        <Divider sx={{ borderColor: "#e7ebf6" }} />
        <Box sx={{ p: 1.15, display: "grid", gap: 0.9 }}>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            Block {round.blockNumber || "unavailable"} / snapshot {round.snapshot?.source || "unknown"} / cursor {round.snapshot?.eventCursor || 0} / provider {round.provider || "not selected"}
          </Typography>
          {(round.error || round.warning) && (
            <Alert severity={round.error ? "error" : "warning"} sx={{ py: 0, "& .MuiAlert-message": { fontSize: "0.75rem", overflowWrap: "anywhere" } }}>
              {round.error || round.warning}
            </Alert>
          )}
          {bots.map((bot) => (
            <Box key={bot.id} sx={{ p: 1, borderRadius: 1.25, backgroundColor: "#f8faff", border: "1px solid #e7ebf7" }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
                <Typography variant="caption" sx={{ fontWeight: 800 }}>{bot.name}</Typography>
                <Typography variant="caption" color="text.secondary">{bot.outcome || "completed"} / budget {bot.budgetWei ?? "unreadable"} wei</Typography>
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.35, overflowWrap: "anywhere" }}>
                Primary {(bot.primary || []).map(shortAddress).join(", ") || "none"} / reserve {(bot.reserve || []).map(shortAddress).join(", ") || "none"}
              </Typography>
              <Box sx={{ mt: 0.7, display: "grid", gap: 0.45 }}>
                {(bot.steps || []).length ? bot.steps.map((step, index) => (
                  <Box key={`${step.at || 0}-${index}`} sx={{ display: "grid", gridTemplateColumns: { xs: "76px minmax(0, 1fr)", sm: "86px minmax(120px, 0.7fr) minmax(0, 1.6fr)" }, gap: 0.75, alignItems: "baseline" }}>
                    <Typography variant="caption" sx={{ color: step.outcome === "error" ? "#b42318" : step.outcome === "sent" ? "#168052" : "#53648f", fontWeight: 800 }}>
                      {step.stage || step.outcome || "event"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">{step.auction ? shortAddress(step.auction) : "round"}</Typography>
                    <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                      {step.reason || step.detail || step.outcome || "completed"}
                      {step.transactionHash && (
                        <Box component="a" href={`https://sepolia.etherscan.io/tx/${step.transactionHash}`} target="_blank" rel="noreferrer" sx={{ ml: 0.7, color: "#173b91", fontWeight: 700, textDecoration: "none" }}>
                          transaction
                        </Box>
                      )}
                    </Typography>
                  </Box>
                )) : (
                  <Typography variant="caption" color="text.secondary">
                    {bot.outcome === "not-started" ? "Round stopped before bot assignment." : "No candidate work was assigned."}
                  </Typography>
                )}
              </Box>
            </Box>
          ))}
          {(round.finalization || []).map((entry, index) => (
            <Typography key={`${entry.auction}-${index}`} variant="caption" sx={{ color: entry.outcome === "error" ? "#b42318" : "#168052", overflowWrap: "anywhere" }}>
              Finalization {shortAddress(entry.auction)}: {entry.reason || entry.outcome}
            </Typography>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};

const BotObservatory = ({ rounds, open, onToggle, onClear }) => {
  const latest = rounds[0];
  return (
    <Box sx={{ border: "1px solid #dfe6f7", borderRadius: 2, background: "linear-gradient(145deg, #ffffff, #f8faff)", boxShadow: "0 5px 16px rgba(24, 52, 121, 0.04)", overflow: "hidden" }}>
      <Box sx={{ px: 1.5, py: 1.25, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 1, alignItems: "center" }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 800 }}>Bot observatory</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.35 }}>
            Inspect coordinated assignments, candidate decisions, queued writes, receipts, skips, and failures round by round.
          </Typography>
          {!open && latest && (
            <Typography variant="caption" sx={{ display: "block", mt: 0.45, color: "#53648f" }}>
              Latest {formatDate(latest.startedAt)} / {latest.bots?.length || 0} bots / {latest.snapshot?.activeAuctions || 0} active
            </Typography>
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.35 }}>
          {open && (
            <Tooltip title="Clear observatory history">
              <span>
                <IconButton size="small" onClick={onClear} disabled={!rounds.length} aria-label="Clear bot observatory history">
                  <DeleteSweepRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <IconButton size="small" onClick={onToggle} aria-label={open ? "Collapse bot observatory" : "Expand bot observatory"}>
            <KeyboardArrowDownRoundedIcon fontSize="small" sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 90ms ease" }} />
          </IconButton>
        </Box>
      </Box>
      <Collapse in={open} timeout={90} unmountOnExit>
        <Divider sx={{ borderColor: "#e6ebf7" }} />
        <Box sx={{ p: 1.25, display: "grid", gap: 0.75, maxHeight: 520, overflowY: "auto", overflowX: "hidden" }}>
          {rounds.length ? rounds.map((round) => <ObservatoryRound key={round.id} round={round} />) : (
            <Box sx={{ py: 2.5, textAlign: "center" }}><Typography variant="body2" color="text.secondary">No coordinated rounds have been observed in this browser yet.</Typography></Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

const sendContractTx = async (method, options) => {
  const gas = await method.estimateGas(options);

  return method.send({
    ...options,
    gas: Math.ceil(Number(gas) * 1.2),
  });
};

export const getBidDecision = getSharedBidDecision;

const BotnetControlPanel = ({
  headless = false,
  schedulerEnabled = true,
  externalScheduler = false,
}) => {
  const activeFactoryAddress = getActiveFactoryAddress();
  const keyFileInputRef = useRef(null);
  const rpcIndexRef = useRef(0);
  const registryCooldownUntilRef = useRef(0);
  const schedulerTickRunningRef = useRef(false);
  const coordinatorFactoryRef = useRef("");
  const cycleCursorRef = useRef(0);
  const cancelledBotsRef = useRef(new Set());
  const finalizationLastRunRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [bots, setBots] = useState([]);
  const [logs, setLogs] = useState([]);
  const [logFilter, setLogFilter] = useState("all");
  const [error, setError] = useState("");
  const [rpcNotice, setRpcNotice] = useState("");
  const [showBotForm, setShowBotForm] = useState(false);
  const [botForm, setBotForm] = useState(emptyBotForm);
  const [registrySnapshot, setRegistrySnapshot] = useState(() =>
    getActiveAuctionSnapshot(activeFactoryAddress),
  );
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registryRefreshing, setRegistryRefreshing] = useState(false);
  const [registryClock, setRegistryClock] = useState(Date.now());
  const [observatoryRounds, setObservatoryRounds] = useState(() =>
    loadStoredObservatoryRounds(),
  );
  const [observatoryOpen, setObservatoryOpen] = useState(false);

  const summary = useMemo(
    () =>
      bots.reduce(
        (totals, bot) => {
          totals.registered += 1;
          totals.running += bot.running ? 1 : 0;
          totals.cycles += bot.stats?.cycles || 0;
          totals.errors += bot.stats?.errors || 0;
          return totals;
        },
        { registered: 0, running: 0, cycles: 0, errors: 0 }
      ),
    [bots]
  );

  const logCounts = useMemo(
    () =>
      logs.reduce(
        (counts, entry) => {
          const level = String(entry.level || "info").toLowerCase();
          counts.all += 1;
          if (Object.prototype.hasOwnProperty.call(counts, level)) {
            counts[level] += 1;
          }
          return counts;
        },
        { all: 0, error: 0, warn: 0, info: 0 }
      ),
    [logs]
  );

  const visibleLogs = useMemo(
    () =>
      logs
        .filter(
          (entry) =>
            logFilter === "all" ||
            String(entry.level || "info").toLowerCase() === logFilter
        )
        .slice(0, 40),
    [logFilter, logs]
  );

  const commitBots = useCallback((updater) => {
    setBots(() => {
      const latestStoredBots = loadStoredBots();
      const next =
        typeof updater === "function"
          ? updater(latestStoredBots)
          : updater;
      const normalized = ensureSingleMetaMaskAgentBot(next);
      saveStoredBots(normalized);
      return normalized;
    });
  }, []);

  const addLog = useCallback((level, message, meta = {}) => {
    setLogs((current) => {
      const next = [createLog(level, message, meta), ...current].slice(0, 120);
      saveStoredLogs(next);
      return next;
    });
  }, []);

  const recordObservatoryRound = useCallback((round) => {
    const immutableRound = JSON.parse(JSON.stringify(round));
    const next = appendStoredObservatoryRound(immutableRound);
    setObservatoryRounds(next);
  }, []);

  const clearObservatory = useCallback(() => {
    saveStoredObservatoryRounds([]);
    setObservatoryRounds([]);
    toast.success("Bot observatory history cleared");
  }, []);

  const coolDownRpcUrl = useCallback(
    (rpcUrl, error, { surface = false } = {}) => {
      if (!rpcUrl) return;
      const health = markRpcProviderFailure(rpcUrl, error);
      if (!surface) return;
      const message = getFriendlyRpcError(error);
      setRpcNotice(message);
      addLog("warn", message, {
        provider: (() => {
          try {
            return new URL(rpcUrl).hostname;
          } catch (_) {
            return "configured RPC";
          }
        })(),
        failureKind: health?.kind || getRpcFailureKind(error),
      });
    },
    [addLog]
  );

  const loadBotnet = useCallback(() => {
    setLoading(true);
    setError("");
    try {
      setBots(loadStoredBots());
      setLogs(loadStoredLogs());
      setObservatoryRounds(loadStoredObservatoryRounds());
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBotnet();
  }, [loadBotnet]);

  useEffect(() => {
    const syncVisiblePanel = () => {
      setBots(loadStoredBots());
      setLogs(loadStoredLogs());
      setObservatoryRounds(loadStoredObservatoryRounds());
    };

    window.addEventListener(BOTNET_STATE_EVENT, syncVisiblePanel);
    return () => {
      window.removeEventListener(BOTNET_STATE_EVENT, syncVisiblePanel);
    };
  }, []);

  useEffect(() => {
    const factoryKey = String(activeFactoryAddress || "").toLowerCase();
    setRegistrySnapshot(getActiveAuctionSnapshot(activeFactoryAddress));
    setRegistryClock(Date.now());
    return subscribeActiveAuctionRegistry((snapshot) => {
      if (String(snapshot?.factoryAddress || "").toLowerCase() !== factoryKey) return;
      setRegistrySnapshot(snapshot);
      setRegistryClock(Date.now());
    });
  }, [activeFactoryAddress]);

  useEffect(() => {
    if (!registryOpen) return undefined;
    const timer = window.setInterval(() => setRegistryClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [registryOpen]);

  const refreshRegistryView = useCallback(async () => {
    setRegistryRefreshing(true);
    try {
      const snapshot = await refreshActiveAuctionRegistry(activeFactoryAddress, { force: true });
      setRegistrySnapshot(snapshot);
      setRegistryClock(Date.now());
      toast.success("Dynamic auction list refreshed");
    } catch (refreshError) {
      const message = isRpcProviderFailure(refreshError)
        ? getFriendlyRpcError(refreshError)
        : getErrorMessage(refreshError);
      setRpcNotice(message);
      addLog(isRpcProviderFailure(refreshError) ? "warn" : "error", "Dynamic auction list refresh failed", {
        error: message,
      });
    } finally {
      setRegistryRefreshing(false);
    }
  }, [activeFactoryAddress, addLog]);

  const updateBot = useCallback(
    (id, patcher) => {
      commitBots((current) =>
        current.map((bot) => {
          if (bot.id !== id) return bot;
          const patch = typeof patcher === "function" ? patcher(bot) : patcher;
          return normalizeBot({ ...bot, ...patch, updatedAt: new Date().toISOString() });
        })
      );
    },
    [commitBots]
  );

  const clearBotError = useCallback(
    (id) => {
      updateBot(id, (bot) => ({
        lastError: null,
        status: bot.running ? "running" : "stopped",
      }));
      addLog("info", "Dismissed stored bot error", { botId: id });
    },
    [addLog, updateBot]
  );

  const retryRpcProviders = useCallback(() => {
    resetRpcProviderHealth();
    registryCooldownUntilRef.current = 0;
    setRpcNotice("");
    setError("");
    addLog("info", "Cleared RPC cooldowns; providers will retry on the next cycle");
    toast.success("RPC providers are ready to retry");
  }, [addLog]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    saveStoredLogs([]);
    toast.success("Bot event history cleared");
  }, []);

  const runBotsInBatches = useCallback(
    async (selectedBots, limit = selectedBots.length) => {
      const runnableBots = selectedBots
        .filter((bot) => bot.enabled && isBrowserRunnableBot(bot))
        .slice(0, limit);
      if (!runnableBots.length) return false;

      if (registryCooldownUntilRef.current > Date.now()) {
        const seconds = Math.max(
          1,
          Math.ceil((registryCooldownUntilRef.current - Date.now()) / 1000),
        );
        setRpcNotice(`Active auction refresh is cooling down. Retrying in about ${seconds}s.`);
        return false;
      }

      const factoryAddress = getActiveFactoryAddress();
      if (!factoryAddress) throw new Error("No active factory contract configured.");
      let rpcUrl = "";
      let web3 = null;
      const startedAt = Date.now();
      const roundTrace = {
        id: `browser-${startedAt.toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
        startedAt,
        finishedAt: null,
        status: "running",
        factoryAddress,
        provider: "selecting healthy connection",
        blockNumber: null,
        snapshot: null,
        bots: [],
        finalization: [],
      };
      let sharedSnapshot;
      try {
        sharedSnapshot = await refreshActiveAuctionRegistry(factoryAddress);
      } catch (snapshotError) {
        const failureKind = getRpcFailureKind(snapshotError);
        const cooldownMs =
          failureKind === "unsupported-plan"
            ? 24 * 60 * 60 * 1000
            : failureKind === "network"
              ? 15000
              : BOT_RPC_RATE_LIMIT_COOLDOWN_MS;
        registryCooldownUntilRef.current = Date.now() + cooldownMs;
        const message = isRpcProviderFailure(snapshotError)
          ? getFriendlyRpcError(snapshotError)
          : `Active auction refresh failed: ${getErrorMessage(snapshotError)}`;
        const cached = getUsableCachedAuctionSnapshot(
          getActiveAuctionSnapshot(factoryAddress),
        );
        if (cached) {
          sharedSnapshot = cached.snapshot;
          roundTrace.degraded = true;
          roundTrace.warning = `${message} Using the recent shared auction index for this round.`;
          setRpcNotice(roundTrace.warning);
          addLog("warn", "Active auction refresh failed; using the recent shared index", {
            snapshotAgeMs: cached.ageMs,
            failureKind,
          });
        } else {
          setRpcNotice(message);
          addLog(isRpcProviderFailure(snapshotError) ? "warn" : "error", message);
          recordObservatoryRound({
            ...roundTrace,
            finishedAt: Date.now(),
            status: "snapshot-failed",
            error: message,
            bots: runnableBots.map((bot) => ({
              id: bot.id,
              name: bot.name,
              wallet: bot.wallet,
              outcome: "not-started",
              primary: [],
              reserve: [],
              steps: [],
            })),
          });
          return false;
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const contexts = runnableBots.map((bot) => {
        const account = getCachedAccount(web3ForKeys, bot.privateKey);
        return { bot, account, strategy: getStrategy(bot) };
      });
      const activeAuctions = sharedSnapshot.activeAuctions || [];
      const allocation = allocateCycleCandidates({
        bots: contexts
          .filter(({ strategy }) => strategy.enableBidding)
          .map(({ bot, account, strategy }) => ({ id: bot.id, wallet: account.address, strategy })),
        auctions: activeAuctions,
        cursor: cycleCursorRef.current,
        nowSec,
      });
      cycleCursorRef.current = allocation.nextCursor;

      roundTrace.snapshot = {
        updatedAt: Number(sharedSnapshot.updatedAt || 0),
        source: sharedSnapshot.source || "unknown",
        discoveryMode: sharedSnapshot.discoveryMode || "unknown",
        eventCursor: Number(sharedSnapshot.eventCursor || 0),
        activeAuctions: activeAuctions.length,
        finalizableAuctions: sharedSnapshot.finalizableAuctions?.length || 0,
        knownAddressCount: Number(sharedSnapshot.knownAddressCount || 0),
        unreadableCount: Number(sharedSnapshot.unreadableCount || 0),
      };
      roundTrace.bots = contexts.map(({ bot, account, strategy }) => {
        const assigned = allocation.assignments[bot.id] || { primary: [], reserve: [] };
        return {
          id: bot.id,
          name: bot.name,
          wallet: account.address,
          outcome: "planned",
          budgetWei: null,
          maxBidsPerCycle: strategy.maxBidsPerCycle,
          primary: assigned.primary.map((auction) => auction.address),
          reserve: assigned.reserve.map((auction) => auction.address),
          steps: !assigned.primary.length && !assigned.reserve.length
            ? [{ at: Date.now(), stage: "planner", outcome: "skipped", reason: "No eligible active auctions were assigned" }]
            : [],
          metrics: null,
        };
      });
      const traceByBot = new Map(roundTrace.bots.map((bot) => [bot.id, bot]));
      recordObservatoryRound({ ...roundTrace, status: "planned" });

      let blockNumber = null;
      let readSpecs = [];
      let readResults = [];
      const batchSize = 25;
      try {
        const connection = await executeWithRpcFailover(
          RPC_URLS,
          async (candidateUrl) => {
            const candidateWeb3 = getCachedWeb3(candidateUrl);
            const candidateFactory = getCachedFactory(
              candidateWeb3,
              candidateUrl,
              factoryAddress,
            );
            contexts.forEach(({ bot }) => {
              getCachedAccount(candidateWeb3, bot.privateKey);
            });
            const candidateBlock = await candidateWeb3.eth.getBlockNumber();
            const candidateSpecs = [];
            contexts.forEach(({ bot, account, strategy }) => {
              if (!strategy.enableBidding) return;
              const assigned = allocation.assignments[bot.id] || { primary: [], reserve: [] };
              if (!assigned.primary.length && !assigned.reserve.length) return;
              candidateSpecs.push({
                type: "budget",
                botId: bot.id,
                method: candidateFactory.methods.getBudget(account.address),
              });
              [...assigned.primary, ...assigned.reserve].forEach((auction) => {
                candidateSpecs.push({
                  type: "bid",
                  botId: bot.id,
                  auctionAddress: auction.address,
                  method: getCachedCampaign(
                    candidateWeb3,
                    candidateUrl,
                    auction.address,
                  ).methods.getBid(account.address),
                });
              });
            });

            const candidateResults = [];
            for (let offset = 0; offset < candidateSpecs.length; offset += batchSize) {
              const chunk = candidateSpecs.slice(offset, offset + batchSize);
              const chunkResults = await executeBatchCalls(
                candidateWeb3,
                chunk.map((item) => item.method),
                candidateBlock,
              );
              const providerFailure = chunkResults.find(
                (result) =>
                  result?.status === "rejected" &&
                  isRpcProviderFailure(result.reason),
              );
              if (providerFailure) throw providerFailure.reason;
              candidateResults.push(...chunkResults);
            }

            return {
              web3: candidateWeb3,
              blockNumber: candidateBlock,
              readSpecs: candidateSpecs,
              readResults: candidateResults,
            };
          },
          { startIndex: rpcIndexRef.current },
        );

        rpcUrl = connection.url;
        web3 = connection.value.web3;
        blockNumber = connection.value.blockNumber;
        readSpecs = connection.value.readSpecs;
        readResults = connection.value.readResults;
        rpcIndexRef.current = (RPC_URLS.indexOf(rpcUrl) + 1) % Math.max(1, RPC_URLS.length);
        roundTrace.provider = (() => {
          try {
            return new URL(rpcUrl).hostname;
          } catch (_) {
            return "configured RPC";
          }
        })();
        roundTrace.blockNumber = Number(blockNumber);
      } catch (connectionError) {
        const message = getFriendlyRpcError(connectionError);
        roundTrace.bots.forEach((bot) => {
          bot.outcome = "deferred";
          bot.steps.push({
            at: Date.now(),
            stage: "connection",
            outcome: "deferred",
            reason: "All connections are unavailable; this bot remains running and will retry next cycle",
          });
        });
        roundTrace.provider = "all connections attempted";
        recordObservatoryRound({
          ...roundTrace,
          finishedAt: Date.now(),
          status: "connection-deferred",
          warning: message,
        });
        setRpcNotice(message);
        return false;
      }

      const budgets = new Map();
      const bids = new Map();
      readSpecs.forEach((spec, index) => {
        const result = readResults[index];
        if (result?.status !== "fulfilled") {
          const trace = traceByBot.get(spec.botId);
          trace?.steps.push({
            at: Date.now(),
            stage: spec.type === "budget" ? "budget-read" : "bid-read",
            auction: spec.auctionAddress || "",
            outcome: "error",
            reason: getErrorMessage(result?.reason || "RPC batch item failed"),
          });
          return;
        }
        if (spec.type === "budget") budgets.set(spec.botId, toBigIntSafe(result.value));
        else bids.set(`${spec.botId}:${String(spec.auctionAddress).toLowerCase()}`, toBigIntSafe(result.value));
      });
      roundTrace.bots.forEach((trace) => {
        if (budgets.has(trace.id)) trace.budgetWei = budgets.get(trace.id).toString();
      });

      const runPreparedBot = async ({ bot, account, strategy }, workerIndex) => {
        const botTrace = traceByBot.get(bot.id);
        if (activeBotCycles.has(bot.id)) {
          if (botTrace) {
            botTrace.outcome = "already-running";
            botTrace.steps.push({ at: Date.now(), stage: "scheduler", outcome: "skipped", reason: "A previous cycle is still running" });
          }
          return false;
        }
        activeBotCycles.add(bot.id);
        const baseMetrics = createEmptyCycleMetrics(startedAt);
        const assigned = allocation.assignments[bot.id] || { primary: [], reserve: [] };
        let budget = budgets.get(bot.id) ?? 0n;
        let sent = 0;
        let attempted = 0;
        let lastDecision = { reason: assigned.primary.length ? "No eligible bid" : "No eligible active auctions" };
        updateBot(bot.id, { status: "running-cycle", lastCycleAt: new Date().toISOString(), lastError: null });

        try {
          if (workerIndex > 0 && BOT_START_STAGGER_MS > 0) await sleep(workerIndex * BOT_START_STAGGER_MS);
          for (const auction of [...assigned.primary, ...assigned.reserve]) {
            if (sent >= strategy.maxBidsPerCycle || cancelledBotsRef.current.has(bot.id)) break;
            const bidKey = `${bot.id}:${String(auction.address).toLowerCase()}`;
            if (!bids.has(bidKey)) {
              botTrace?.steps.push({ at: Date.now(), stage: "bid-read", auction: auction.address, outcome: "skipped", reason: "Bid state was unavailable" });
              continue;
            }
            const endTimeSec = Number(auction.endTimeSec || 0);
            const candidate = {
              ...auction,
              campaign: getCachedCampaign(web3, rpcUrl, auction.address),
              minimumContribution: toBigIntSafe(auction.minimumContribution),
              highestBid: toBigIntSafe(auction.highestBid),
              myBid: bids.get(bidKey),
              isActive: !auction.closed && endTimeSec > nowSec,
              secondsLeft: Math.max(0, endTimeSec - nowSec),
              isManager: String(auction.manager || "").toLowerCase() === account.address.toLowerCase(),
              isWinner: String(auction.highestBidder || "").toLowerCase() === account.address.toLowerCase(),
            };
            const decision = getBidDecision(candidate, budget, strategy);
            lastDecision = decision;
            botTrace?.steps.push({
              at: Date.now(),
              stage: "decision",
              auction: candidate.address,
              outcome: decision.bid ? "eligible" : "skipped",
              reason: decision.reason || (decision.bid ? `Bid ${decision.amountWei.toString()} wei` : "Not eligible"),
              amountWei: decision.bid ? decision.amountWei.toString() : "0",
            });
            if (!decision.bid) continue;
            attempted += 1;
            botTrace?.steps.push({ at: Date.now(), stage: "write", auction: candidate.address, outcome: "attempted", reason: `Submitting ${decision.amountWei.toString()} wei` });

            try {
              const receipt = await withBrowserWriteSlot(() => {
                if (cancelledBotsRef.current.has(bot.id)) return Promise.resolve(null);
                return sendContractTx(candidate.campaign.methods.contribute(), {
                  from: account.address,
                  value: decision.amountWei.toString(),
                });
              });
              if (!receipt || cancelledBotsRef.current.has(bot.id)) {
                botTrace?.steps.push({ at: Date.now(), stage: "write", auction: candidate.address, outcome: "cancelled", reason: "Stopped before the queued write was submitted" });
                break;
              }
              budget -= decision.amountWei;
              sent += 1;
              if (botTrace) botTrace.budgetWei = budget.toString();
              botTrace?.steps.push({
                at: Date.now(),
                stage: "receipt",
                auction: candidate.address,
                outcome: "sent",
                reason: `Confirmed ${decision.amountWei.toString()} wei bid`,
                transactionHash: receipt.transactionHash || "",
              });
              publishActiveAuctions(factoryAddress, [{
                ...candidate,
                highestBid: decision.targetBid.toString(),
                highestBidder: account.address,
                approversCount: Number(candidate.approversCount || 0) + (candidate.myBid === 0n ? 1 : 0),
              }], "bot-bid");
              addLog("info", `Bid sent by ${bot.name}`, {
                auction: candidate.address,
                amountWei: decision.amountWei.toString(),
              });
            } catch (bidError) {
              botTrace?.steps.push({
                at: Date.now(),
                stage: "write",
                auction: candidate.address,
                outcome: "error",
                reason: isRpcProviderFailure(bidError) ? getFriendlyRpcError(bidError) : getErrorMessage(bidError),
              });
              if (isRpcProviderFailure(bidError)) {
                coolDownRpcUrl(rpcUrl, bidError);
                throw bidError;
              }
              addLog("warn", `Bid attempt skipped for ${candidate.address}`, {
                bot: bot.name,
                error: getErrorMessage(bidError),
              });
            }
          }

          const metrics = finishCycleMetrics(baseMetrics, {
            snapshotAgeMs: Math.max(0, startedAt - Number(sharedSnapshot.updatedAt || startedAt)),
            activeAuctions: activeAuctions.length,
            logicalReads: assigned.primary.length + assigned.reserve.length + (assigned.primary.length ? 1 : 0),
            rpcBatches: readSpecs.length ? Math.ceil(readSpecs.length / batchSize) : 0,
            candidatesEvaluated: allocation.candidatesEvaluated,
            bidsAttempted: attempted,
            bidsSent: sent,
            cacheHits: activeAuctions.length,
            skippedReason: sent ? "" : lastDecision.reason,
          });
          if (botTrace) {
            botTrace.outcome = cancelledBotsRef.current.has(bot.id)
              ? "cancelled"
              : sent
                ? "bid-sent"
                : "no-bid";
            botTrace.metrics = metrics;
            if (cancelledBotsRef.current.has(bot.id)) {
              botTrace.steps.push({ at: Date.now(), stage: "scheduler", outcome: "cancelled", reason: "Bot was stopped during the round" });
            }
          }
          updateBot(bot.id, (current) => ({
            status: current.running ? "running" : "stopped",
            wallet: account.address,
            lastCycleMetrics: metrics,
            stats: {
              ...current.stats,
              cycles: (current.stats?.cycles || 0) + 1,
              bids: (current.stats?.bids || 0) + sent,
            },
          }));
          if (!sent) addLog("info", `No bid sent by ${bot.name}: ${lastDecision.reason}`);
          return true;
        } catch (cycleError) {
          const providerFailure = isRpcProviderFailure(cycleError);
          if (botTrace) {
            botTrace.outcome = providerFailure ? "provider-failed" : "cycle-failed";
            botTrace.steps.push({
              at: Date.now(),
              stage: "cycle",
              outcome: "error",
              reason: providerFailure ? getFriendlyRpcError(cycleError) : getErrorMessage(cycleError),
            });
          }
          updateBot(bot.id, (current) => ({
            status: current.running ? "running" : providerFailure ? "stopped" : "error",
            lastError: providerFailure ? getFriendlyRpcError(cycleError) : getErrorMessage(cycleError),
            lastCycleMetrics: finishCycleMetrics(baseMetrics, {
              activeAuctions: activeAuctions.length,
              bidsAttempted: attempted,
              bidsSent: sent,
              skippedReason: providerFailure ? "RPC provider unavailable" : "Cycle failed",
            }),
            stats: {
              ...current.stats,
              errors: providerFailure ? current.stats?.errors || 0 : (current.stats?.errors || 0) + 1,
            },
          }));
          return false;
        } finally {
          activeBotCycles.delete(bot.id);
          recordObservatoryRound({ ...roundTrace, status: "running" });
        }
      };

      const workerCount = Math.min(BOT_MAX_BOTS_PER_TICK, contexts.length);
      let nextIndex = 0;
      let completedCycles = 0;
      await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => {
        while (nextIndex < contexts.length) {
          const context = contexts[nextIndex];
          nextIndex += 1;
          if (await runPreparedBot(context, workerIndex)) completedCycles += 1;
        }
      }));

      if (Date.now() - finalizationLastRunRef.current >= BOT_FINALIZE_INTERVAL_MS) {
        finalizationLastRunRef.current = Date.now();
        for (const auction of (sharedSnapshot.finalizableAuctions || []).slice(0, 2)) {
          const owner = contexts.find(({ account, strategy }) =>
            strategy.enableFinalize &&
            account.address.toLowerCase() === String(auction.manager || "").toLowerCase(),
          );
          if (!owner || cancelledBotsRef.current.has(owner.bot.id)) {
            roundTrace.finalization.push({
              at: Date.now(),
              auction: auction.address,
              outcome: "skipped",
              reason: owner ? "Owner bot was stopped" : "No enabled seller bot controls this auction",
            });
            continue;
          }
          try {
            const campaign = getCachedCampaign(web3, rpcUrl, auction.address);
            const receipt = await withBrowserWriteSlot(() => {
              if (cancelledBotsRef.current.has(owner.bot.id)) return Promise.resolve(null);
              return sendContractTx(campaign.methods.finalizeAuctionIfNeeded(), {
                from: owner.account.address,
              });
            });
            if (!receipt) {
              roundTrace.finalization.push({ at: Date.now(), auction: auction.address, outcome: "cancelled", reason: "Finalization was cancelled before submission" });
              continue;
            }
            markAuctionClosed(factoryAddress, auction.address, "bot-finalized");
            roundTrace.finalization.push({
              at: Date.now(),
              auction: auction.address,
              outcome: "sent",
              reason: "Seller payment finalized",
              transactionHash: receipt.transactionHash || "",
            });
            updateBot(owner.bot.id, (current) => ({
              stats: {
                ...current.stats,
                finalized: (current.stats?.finalized || 0) + 1,
              },
            }));
            addLog("info", `Finalized auction ${auction.address}`, { bot: owner.bot.name });
          } catch (finalizeError) {
            roundTrace.finalization.push({
              at: Date.now(),
              auction: auction.address,
              outcome: "error",
              reason: isRpcProviderFailure(finalizeError) ? getFriendlyRpcError(finalizeError) : getErrorMessage(finalizeError),
            });
            if (isRpcProviderFailure(finalizeError)) coolDownRpcUrl(rpcUrl, finalizeError);
            addLog("warn", `Finalize failed for ${auction.address}`, {
              bot: owner.bot.name,
              error: getErrorMessage(finalizeError),
            });
          }
        }
      }

      recordObservatoryRound({
        ...roundTrace,
        finishedAt: Date.now(),
        status: roundTrace.degraded
          ? completedCycles
            ? "completed-with-cached-index"
            : "cached-index-no-cycle"
          : completedCycles === contexts.length
            ? "completed"
            : completedCycles
              ? "partial"
              : "no-cycle-completed",
      });
      return completedCycles > 0;
    },
    [addLog, coolDownRpcUrl, recordObservatoryRound, updateBot]
  );

  useEffect(() => {
    if (!schedulerEnabled) return undefined;

    const runSchedulerTick = async () => {
      if (schedulerTickRunningRef.current) return;
      const factoryAddress = getActiveFactoryAddress();
      if (
        coordinatorFactoryRef.current &&
        coordinatorFactoryRef.current.toLowerCase() !== factoryAddress.toLowerCase()
      ) {
        releaseActiveAuctionCoordinatorLease(coordinatorFactoryRef.current);
        coordinatorFactoryRef.current = "";
      }
      if (!acquireActiveAuctionCoordinatorLease(factoryAddress)) return;
      coordinatorFactoryRef.current = factoryAddress;
      schedulerTickRunningRef.current = true;

      try {
        const currentBots = loadStoredBots();
        const dueBots = currentBots.filter((bot) => {
          if (!bot.running || !bot.enabled || !isBrowserRunnableBot(bot)) {
            return false;
          }
          const strategy = getStrategy(bot);
          const lastCycle = bot.lastCycleAt ? new Date(bot.lastCycleAt).getTime() : 0;
          return !lastCycle || Date.now() - lastCycle >= strategy.intervalSec * 1000;
        });

        await runBotsInBatches(dueBots, BOT_MAX_BOTS_PER_TICK);
      } finally {
        schedulerTickRunningRef.current = false;
      }
    };

    let timer = null;
    if (externalScheduler) {
      window.addEventListener(BOT_SCHEDULER_TICK_EVENT, runSchedulerTick);
    } else {
      timer = window.setInterval(runSchedulerTick, BOT_SCHEDULER_TICK_MS);
      runSchedulerTick();
    }

    return () => {
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener(BOT_SCHEDULER_TICK_EVENT, runSchedulerTick);
      if (coordinatorFactoryRef.current) {
        releaseActiveAuctionCoordinatorLease(coordinatorFactoryRef.current);
        coordinatorFactoryRef.current = "";
      }
    };
  }, [externalScheduler, runBotsInBatches, schedulerEnabled]);

  const runAction = async (key, action, body = {}) => {
    setActionLoading(key);
    setError("");
    try {
      if (action === "start-network") {
        cancelledBotsRef.current.clear();
        commitBots((current) =>
          current.map((bot) =>
            bot.enabled && isBrowserRunnableBot(bot)
              ? { ...bot, running: true, status: "running", lastError: null }
              : bot
          )
        );
        toast.success("Enabled bots started in the Admin Zone");
      } else if (action === "stop-network") {
        loadStoredBots().forEach((bot) => cancelledBotsRef.current.add(bot.id));
        commitBots((current) =>
          current.map((bot) => ({ ...bot, running: false, status: "stopped" }))
        );
        toast.success("All bots stopped");
      } else if (action === "run-network") {
        const selected = loadStoredBots().filter(
          (bot) => bot.enabled && isBrowserRunnableBot(bot),
        );
        const completed = await runBotsInBatches(selected);
        if (completed) toast.success("Enabled bots ran once");
        else toast.error("No bot cycle completed. Check the connection notice and bot events.");
      } else if (action === "start-bot") {
        const bot = loadStoredBots().find((item) => item.id === body.id);
        if (isMetaMaskAgentBot(bot)) {
          toast.error("The Agent Wallet bot is controlled by the Node automation runner.");
          return;
        }
        cancelledBotsRef.current.delete(body.id);
        updateBot(body.id, { running: true, status: "running", lastError: null });
        toast.success("Bot started");
      } else if (action === "stop-bot") {
        cancelledBotsRef.current.add(body.id);
        updateBot(body.id, { running: false, status: "stopped" });
        toast.success("Bot stopped");
      } else if (action === "run-bot") {
        const bot = loadStoredBots().find((item) => item.id === body.id);
        if (isMetaMaskAgentBot(bot)) {
          toast.error("Run this bot through the MetaMask Agent Wallet automation runner.");
          return;
        }
        cancelledBotsRef.current.delete(body.id);
        const completed = await runBotsInBatches([{ ...bot, enabled: true }], 1);
        if (completed) toast.success("Bot ran once");
        else toast.error("The bot cycle did not complete. Check its status and recent events.");
      } else if (action === "delete-bot") {
        commitBots((current) => current.filter((bot) => bot.id !== body.id));
        toast.success("Bot deleted");
      }
    } catch (actionError) {
      setError(actionError.message);
      toast.error(actionError.message);
    } finally {
      setActionLoading("");
    }
  };

  const handleBotFormChange = (field, value) => {
    setBotForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSaveBot = async () => {
    if (!botForm.name.trim()) {
      toast.error("Bot name is required");
      return;
    }

    if (!isValidPrivateKey(botForm.privateKey.trim())) {
      toast.error("Use a full private key for the bot wallet");
      return;
    }

    const privateKey = normalizePrivateKey(botForm.privateKey);
    const existing = bots.some(
      (bot) => normalizePrivateKey(bot.privateKey).toLowerCase() === privateKey.toLowerCase()
    );
    if (existing) {
      toast.error("That private key is already assigned to a bot");
      return;
    }

    const bot = normalizeBot({
      name: botForm.name.trim(),
      privateKey,
      enabled: botForm.enabled,
      overrides: {
        MAX_BID_WEI: botForm.maxBidWei || DEFAULT_OVERRIDES.MAX_BID_WEI,
        AUTO_TRADE_INTERVAL_SEC: botForm.intervalSec,
        MAX_BIDS_PER_CYCLE: String(clampBidsPerCycle(botForm.maxBidsPerCycle)),
        ENABLE_BIDDING: botForm.enableBidding ? "true" : "false",
        ENABLE_FINALIZE: botForm.enableFinalize ? "true" : "false",
      },
    });

    commitBots((current) => [...current, bot]);
    addLog("info", `Saved bot ${bot.name}`, { wallet: bot.wallet });
    toast.success("Bot saved");
    setBotForm(emptyBotForm);
    setShowBotForm(false);
  };

  const handlePrivateKeyFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setActionLoading("upload-private-keys");
    setError("");
    try {
      const rawText = await file.text();
      const privateKeys = extractPrivateKeysFromText(rawText);

      if (!privateKeys.length) {
        throw new Error("No valid private keys were found in that file.");
      }

      let assignedCount = 0;
      let skippedCount = 0;
      commitBots((current) => {
        const next = [...current];
        const existingKeys = new Set(
          next
            .filter((bot) => isValidPrivateKey(bot.privateKey))
            .map((bot) => normalizePrivateKey(bot.privateKey).toLowerCase())
        );

        privateKeys.forEach((privateKey) => {
          const key = normalizePrivateKey(privateKey);
          const keyId = key.toLowerCase();
          if (existingKeys.has(keyId)) {
            skippedCount += 1;
            return;
          }

          const targetIndex = next.findIndex(
            (bot) => !isMetaMaskAgentBot(bot) && !isValidPrivateKey(bot.privateKey),
          );
          const target = normalizeBot({
            ...(targetIndex >= 0 ? next[targetIndex] : {}),
            name:
              targetIndex >= 0
                ? next[targetIndex].name
                : `Uploaded Bot ${next.length + 1}`,
            privateKey: key,
            enabled: true,
            running: false,
            status: "stopped",
            lastError: null,
            overrides: {
              ...(targetIndex >= 0 ? next[targetIndex].overrides : DEFAULT_OVERRIDES),
            },
          });

          if (targetIndex >= 0) {
            next[targetIndex] = target;
          } else {
            next.push(target);
          }

          existingKeys.add(keyId);
          assignedCount += 1;
        });

        return next;
      });

      addLog("info", `Uploaded private-key file ${file.name}`, {
        assigned: assignedCount,
        skipped: skippedCount,
      });
      toast.success(
        skippedCount
          ? `Assigned ${assignedCount} key(s), skipped ${skippedCount} duplicate(s)`
          : `Assigned ${assignedCount} key(s) to bot profiles`
      );
    } catch (uploadError) {
      setError(uploadError.message);
      toast.error(uploadError.message);
    } finally {
      setActionLoading("");
    }
  };

  const isBusy = Boolean(actionLoading);
  const formActivity = getActivityUsage(botForm.intervalSec, botForm.maxBidsPerCycle);

  const updateBotBidLimit = (botId, value) => {
    const maxBidsPerCycle = clampBidsPerCycle(value);
    updateBot(botId, (current) => ({
      overrides: {
        ...current.overrides,
        MAX_BIDS_PER_CYCLE: String(maxBidsPerCycle),
      },
    }));
  };

  if (headless) return null;

  return (
    <Box sx={{ display: "grid", gap: 2 }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(4, 1fr)" },
          gap: 1,
        }}
      >
        {[
          ["Registered", summary.registered ?? bots.length],
          ["Running", summary.running ?? 0],
          ["Cycles", summary.cycles ?? 0],
          ["Errors", summary.errors ?? 0],
        ].map(([label, value]) => (
          <Box
            key={label}
            sx={{
              p: 1.5,
              borderRadius: 2,
              backgroundColor: "#fbfcff",
              border: "1px solid #e5e9f8",
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.1 }}>
              {value}
            </Typography>
          </Box>
        ))}
      </Box>

      <Box
        sx={{
          p: 1.5,
          borderRadius: 2,
          backgroundColor: "#fbfcff",
          border: "1px solid #e5e9f8",
        }}
      >
        <Box
          sx={{
            display: "flex",
            gap: 1,
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 800 }}>
              Admin Zone bot engine
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Three bots run locally in the browser; one uses MetaMask Agent Wallet on the
              automation runner. Factory: {shortAddress(getActiveFactoryAddress())}. Runs up
              to {BOT_MAX_BOTS_PER_TICK} bots at the same time with RPC backoff.
            </Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              variant="outlined"
              size="small"
              onClick={loadBotnet}
              disabled={loading}
              sx={{ borderRadius: 999 }}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
            <Button
              variant="contained"
              size="small"
              onClick={() => runAction("start-network", "start-network")}
              disabled={isBusy}
              sx={{ borderRadius: 999, backgroundColor: "#103090" }}
            >
              Start Enabled
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={() => runAction("run-network", "run-network")}
              disabled={isBusy}
              sx={{ borderRadius: 999 }}
            >
              Run Manual Cycle
            </Button>
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => runAction("stop-network", "stop-network")}
              disabled={isBusy}
              sx={{ borderRadius: 999 }}
            >
              Stop All
            </Button>
          </Box>
        </Box>

        {loading && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Reading local bot state...
            </Typography>
          </Box>
        )}

        {rpcNotice && (
          <Alert
            severity="info"
            onClose={() => setRpcNotice("")}
            action={
              <Button color="inherit" size="small" onClick={retryRpcProviders}>
                Reset cooldown
              </Button>
            }
            sx={{ mt: 1.5 }}
          >
            {rpcNotice}
          </Alert>
        )}

        {error && (
          <Alert severity="warning" onClose={() => setError("")} sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
      </Box>

      <DynamicAuctionIndex
        snapshot={registrySnapshot}
        nowMs={registryClock}
        open={registryOpen}
        onToggle={() => setRegistryOpen((current) => !current)}
        onRefresh={refreshRegistryView}
        refreshing={registryRefreshing}
      />

      <BotObservatory
        rounds={observatoryRounds}
        open={observatoryOpen}
        onToggle={() => setObservatoryOpen((current) => !current)}
        onClear={clearObservatory}
      />

      <Box
        sx={{
          p: 1.5,
          borderRadius: 2,
          backgroundColor: "#ffffff",
          border: "1px solid #e5e9f8",
        }}
      >
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            gap: 1,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 800 }}>
            Registered bots
          </Typography>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <input
              ref={keyFileInputRef}
              type="file"
              accept=".txt,.csv,.json,.env"
              onChange={handlePrivateKeyFile}
              style={{ display: "none" }}
            />
            <Button
              variant="outlined"
              size="small"
              startIcon={<UploadFileRoundedIcon />}
              onClick={() => keyFileInputRef.current?.click()}
              disabled={isBusy}
              sx={{ borderRadius: 999 }}
            >
              Upload Keys
            </Button>
            <Button
              variant="contained"
              size="small"
              startIcon={<AddRoundedIcon />}
              onClick={() => setShowBotForm((current) => !current)}
              sx={{ borderRadius: 999, backgroundColor: "#103090" }}
            >
              {showBotForm ? "Close" : "Add Bot"}
            </Button>
          </Box>
        </Box>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 0.75 }}
        >
          Upload a text, CSV, JSON, or env-style file. Each valid private key is
          assigned to a different Admin Zone bot and kept in this browser.
        </Typography>

        {showBotForm && (
          <Box
            sx={{
              mt: 1.5,
              p: 1.5,
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
              gap: 1,
              borderRadius: 2,
              backgroundColor: "#f7f9ff",
              border: "1px solid #e5e9f8",
            }}
          >
            <TextField
              label="Bot name"
              size="small"
              value={botForm.name}
              onChange={(event) => handleBotFormChange("name", event.target.value)}
            />
            <TextField
              label="Private key"
              size="small"
              value={botForm.privateKey}
              onChange={(event) =>
                handleBotFormChange("privateKey", event.target.value)
              }
            />
            <TextField
              label="Max bid wei"
              size="small"
              type="number"
              value={botForm.maxBidWei}
              onChange={(event) =>
                handleBotFormChange("maxBidWei", event.target.value)
              }
            />
            <TextField
              label="Interval seconds"
              size="small"
              type="number"
              value={botForm.intervalSec}
              onChange={(event) =>
                handleBotFormChange("intervalSec", event.target.value)
              }
            />
            <TextField
              label="Maximum bids per cycle"
              size="small"
              type="number"
              value={botForm.maxBidsPerCycle}
              inputProps={{ min: 1, max: 5, step: 1 }}
              onChange={(event) =>
                handleBotFormChange("maxBidsPerCycle", event.target.value)
              }
              helperText={`${formActivity.level} usage - up to ${formActivity.writesPerHour} bid writes/hour`}
            />
            {(formActivity.level === "high" ||
              clampBidsPerCycle(botForm.maxBidsPerCycle) > 1 ||
              Number(botForm.intervalSec) < 30) && (
              <Alert severity="warning" sx={{ gridColumn: { sm: "1 / -1" }, py: 0 }}>
                Elevated activity can consume RPC capacity quickly. Use one bid per cycle and an interval of at least 30 seconds for routine operation.
              </Alert>
            )}
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <Box component="label" sx={{ display: "flex", alignItems: "center" }}>
                <Checkbox
                  checked={botForm.enabled}
                  onChange={(event) =>
                    handleBotFormChange("enabled", event.target.checked)
                  }
                />
                Enabled
              </Box>
              <Box component="label" sx={{ display: "flex", alignItems: "center" }}>
                <Checkbox
                  checked={botForm.enableBidding}
                  onChange={(event) =>
                    handleBotFormChange("enableBidding", event.target.checked)
                  }
                />
                Bidding
              </Box>
              <Box component="label" sx={{ display: "flex", alignItems: "center" }}>
                <Checkbox
                  checked={botForm.enableFinalize}
                  onChange={(event) =>
                    handleBotFormChange("enableFinalize", event.target.checked)
                  }
                />
                Finalize
              </Box>
            </Box>
            <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="contained"
                onClick={handleSaveBot}
                disabled={actionLoading === "save-bot"}
                sx={{ borderRadius: 999, backgroundColor: "#103090" }}
              >
                Save Bot
              </Button>
            </Box>
          </Box>
        )}

        <Box sx={{ display: "grid", gap: 1.25, mt: 1.5 }}>
          {bots.length ? (
            bots.map((bot) => (
              <BotCard
                key={bot.id}
                bot={bot}
                isBusy={isBusy}
                onBidLimitChange={updateBotBidLimit}
                onStart={(id) => runAction(`start-${id}`, "start-bot", { id })}
                onRun={(id) => runAction(`run-${id}`, "run-bot", { id })}
                onStop={(id) => runAction(`stop-${id}`, "stop-bot", { id })}
                onDelete={(id) => runAction(`delete-${id}`, "delete-bot", { id })}
                onClearError={clearBotError}
              />
            ))
          ) : (
            <Typography variant="body2" color="text.secondary">
              No bots registered in the Admin Zone yet.
            </Typography>
          )}
        </Box>
      </Box>

      <Box
        sx={{
          p: 1.5,
          borderRadius: 2,
          background: "linear-gradient(145deg, #ffffff, #f8faff)",
          border: "1px solid #dfe6f7",
          boxShadow: "0 5px 16px rgba(24, 52, 121, 0.04)",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 800 }}>
              Event inspector
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Filter operational events and expand only the diagnostics you need.
            </Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={logFilter}
              onChange={(_, value) => value && setLogFilter(value)}
              aria-label="Filter bot events"
              sx={{
                "& .MuiToggleButton-root": {
                  px: 1.1,
                  py: 0.45,
                  borderColor: "#d8e1f5",
                  textTransform: "none",
                  lineHeight: 1.2,
                },
              }}
            >
              <ToggleButton value="all">All {logCounts.all}</ToggleButton>
              <ToggleButton value="error">Errors {logCounts.error}</ToggleButton>
              <ToggleButton value="warn">Warnings {logCounts.warn}</ToggleButton>
              <ToggleButton value="info">Info {logCounts.info}</ToggleButton>
            </ToggleButtonGroup>
            <Tooltip title="Clear event history">
              <span>
                <IconButton size="small" onClick={clearLogs} disabled={!logs.length} aria-label="Clear bot event history">
                  <DeleteSweepRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>
        <Divider sx={{ my: 1.25, borderColor: "#e6ebf7" }} />
        <Box sx={{ display: "grid", gap: 0.75, maxHeight: 330, pr: 0.35, overflowY: "auto", overflowX: "hidden" }}>
          {visibleLogs.length ? (
            visibleLogs.map((entry, index) => (
              <BotLogEntry
                key={`${entry.time}-${index}`}
                entry={entry}
                onRetryProviders={retryRpcProviders}
              />
            ))
          ) : (
            <Box sx={{ py: 2.25, textAlign: "center" }}>
              <Typography variant="body2" color="text.secondary">
                {logs.length ? `No ${logFilter} events in the current history.` : "No bot events yet."}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default BotnetControlPanel;
