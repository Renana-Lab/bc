import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Divider,
  TextField,
  Typography,
} from "@mui/material";
import toast from "react-hot-toast";
import Web3 from "web3";
import CampaignFactory from "../../real_ethereum/build/CampaignFactory.json";
import Campaign from "../../real_ethereum/build/Campaign.json";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { refreshActiveAuctionRegistry } from "../../real_ethereum/activeAuctionRegistry";
import {
  getConfiguredRpcUrls,
  getFriendlyRpcError,
  getRpcErrorMessage,
  getRpcFailureKind,
  isRpcProviderFailure,
} from "../../real_ethereum/rpcConfig";

const LOCAL_BOTS_KEY = "bc:admin-botnet:bots:v1";
const LOCAL_LOGS_KEY = "bc:admin-botnet:logs:v1";
const BOTNET_STATE_EVENT = "bc:admin-botnet:state-change";
const activeBotCycles = new Set();
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
const BOT_CANDIDATES_PER_CYCLE = Math.max(
  1,
  Number(process.env.REACT_APP_BOT_CANDIDATES_PER_CYCLE || 4)
);

const DEFAULT_OVERRIDES = {
  MAX_BID_WEI: "2000",
  OUTBID_BY_WEI: "10",
  MAX_MIN_CONTRIBUTION_WEI: "2000",
  MIN_TIME_REMAINING_SEC: "20",
  AUTO_TRADE_INTERVAL_SEC: "60",
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
  enableBidding: true,
  enableFinalize: true,
};

const web3ForKeys = new Web3();

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

const normalizePrivateKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("0x") ? raw : `0x${raw}`;
};

const isValidPrivateKey = (value) => /^0x[a-fA-F0-9]{64}$/.test(normalizePrivateKey(value));

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

const normalizeBot = (bot = {}) => {
  const privateKey = normalizePrivateKey(bot.privateKey);
  const validPrivateKey = isValidPrivateKey(privateKey);
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
    privateKey,
    wallet: getWalletAddress(privateKey),
    enabled: validPrivateKey && toBool(bot.enabled, true),
    running: Boolean(bot.running),
    status: validPrivateKey
      ? staleRunningCycle
        ? bot.running
          ? "running"
          : "stopped"
        : bot.status || "stopped"
      : "invalid-config",
    lastCycleAt: bot.lastCycleAt || null,
    lastError: validPrivateKey
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
    overrides: {
      ...DEFAULT_OVERRIDES,
      ...(bot.overrides || {}),
    },
    createdAt: bot.createdAt || new Date().toISOString(),
    updatedAt: bot.updatedAt || new Date().toISOString(),
  };
};

const notifyBotnetStateChanged = () => {
  window.setTimeout(() => {
    window.dispatchEvent(new Event(BOTNET_STATE_EVENT));
  }, 0);
};

const loadStoredBots = () => readJson(LOCAL_BOTS_KEY, []).map(normalizeBot);
const saveStoredBots = (bots) => {
  writeJson(LOCAL_BOTS_KEY, bots.map(normalizeBot));
  notifyBotnetStateChanged();
};
const loadStoredLogs = () => readJson(LOCAL_LOGS_KEY, []);
const saveStoredLogs = (logs) => {
  writeJson(LOCAL_LOGS_KEY, logs.slice(0, 120));
  notifyBotnetStateChanged();
};

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

const getBotStatusColor = (status) => {
  if (status === "running") return "#0f7a46";
  if (status === "crashed" || status === "error") return "#b3261e";
  if (status === "running-cycle") return "#7c5c00";
  if (status === "invalid-config") return "#9a3412";
  return "#5f6680";
};

const extractPrivateKeysFromText = (text = "") => {
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

const getStrategy = (bot) => {
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
    enableBidding: toBool(overrides.ENABLE_BIDDING, true),
    enableFinalize: toBool(overrides.ENABLE_FINALIZE, true),
    skipIfWinning: toBool(overrides.SKIP_IF_WINNING, true),
  };
};

const sendContractTx = async (method, options) => {
  const gas = await method.estimateGas(options);

  return method.send({
    ...options,
    gas: Math.ceil(Number(gas) * 1.2),
  });
};

const getBidDecision = (auction, budget, strategy) => {
  if (!auction) return { bid: false, reason: "No auction candidate" };
  if (!auction.isActive) return { bid: false, reason: "Auction closed" };
  if (auction.isManager) return { bid: false, reason: "Bot is the seller" };
  if (auction.secondsLeft < strategy.minTimeRemainingSec) {
    return { bid: false, reason: "Too little time remaining" };
  }
  if (strategy.skipIfWinning && auction.isWinner) {
    return { bid: false, reason: "Bot already winning" };
  }
  if (auction.minimumContribution > strategy.maxMinContributionWei) {
    return { bid: false, reason: "Minimum contribution too high" };
  }

  const emptyAuction = auction.approversCount === 0 && auction.highestBid === 0n;
  const targetBid = emptyAuction
    ? auction.minimumContribution
    : auction.highestBid + strategy.outbidByWei;
  const incrementalValue = auction.myBid > 0n ? targetBid - auction.myBid : targetBid;

  if (targetBid > strategy.maxBidWei) return { bid: false, reason: "Target bid exceeds max bid" };
  if (incrementalValue <= 0n) return { bid: false, reason: "Existing bid already covers target" };
  if (incrementalValue > budget) return { bid: false, reason: "Insufficient budget" };

  return { bid: true, amountWei: incrementalValue, targetBid };
};

const shuffle = (values) => {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
};

const BotnetControlPanel = ({ headless = false, schedulerEnabled = true }) => {
  const keyFileInputRef = useRef(null);
  const rpcIndexRef = useRef(0);
  const rpcCooldownUntilRef = useRef({});
  const registryCooldownUntilRef = useRef(0);
  const schedulerTickRunningRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [bots, setBots] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [rpcNotice, setRpcNotice] = useState("");
  const [showBotForm, setShowBotForm] = useState(false);
  const [botForm, setBotForm] = useState(emptyBotForm);

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

  const commitBots = useCallback((updater) => {
    setBots((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      const normalized = next.map(normalizeBot);
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

  const getNextRpcUrl = useCallback(() => {
    if (!RPC_URLS.length) return "";

    const now = Date.now();
    for (let attempt = 0; attempt < RPC_URLS.length; attempt += 1) {
      const index = (rpcIndexRef.current + attempt) % RPC_URLS.length;
      const rpcUrl = RPC_URLS[index];
      const cooldownUntil = rpcCooldownUntilRef.current[rpcUrl] || 0;

      if (cooldownUntil <= now) {
        rpcIndexRef.current = (index + 1) % RPC_URLS.length;
        setRpcNotice("");
        return rpcUrl;
      }
    }

    const soonestCooldown = Math.min(
      ...RPC_URLS.map((rpcUrl) => rpcCooldownUntilRef.current[rpcUrl] || now)
    );
    const seconds = Math.max(1, Math.ceil((soonestCooldown - now) / 1000));
    setRpcNotice(`All configured RPC providers are cooling down. Retrying in about ${seconds}s.`);
    return "";
  }, []);

  const coolDownRpcUrl = useCallback(
    (rpcUrl, error) => {
      if (!rpcUrl) return;
      const failureKind = getRpcFailureKind(error);
      const cooldownMs =
        failureKind === "unsupported-plan"
          ? 24 * 60 * 60 * 1000
          : failureKind === "network"
            ? 15000
            : BOT_RPC_RATE_LIMIT_COOLDOWN_MS;
      const until = Date.now() + cooldownMs;
      rpcCooldownUntilRef.current[rpcUrl] = until;
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
        failureKind,
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
    if (headless) return undefined;

    const syncVisiblePanel = () => {
      setBots(loadStoredBots());
      setLogs(loadStoredLogs());
    };

    window.addEventListener(BOTNET_STATE_EVENT, syncVisiblePanel);
    return () => {
      window.removeEventListener(BOTNET_STATE_EVENT, syncVisiblePanel);
    };
  }, [headless]);

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

  const runBotCycle = useCallback(
    async (bot, suppliedSnapshot = null, reservedAuctions = null) => {
      if (!bot || activeBotCycles.has(bot.id)) return false;
      activeBotCycles.add(bot.id);
      updateBot(bot.id, { status: "running-cycle", lastCycleAt: new Date().toISOString(), lastError: null });

      try {
        if (!isValidPrivateKey(bot.privateKey)) throw new Error("Invalid bot private key.");
        const rpcUrl = getNextRpcUrl();
        if (!rpcUrl) {
          updateBot(bot.id, (current) => ({
            status: current.running ? "running" : "stopped",
            lastError: "RPC providers are cooling down. The scheduler will retry later.",
          }));
          return false;
        }
        const factoryAddress = getActiveFactoryAddress();
        if (!factoryAddress) throw new Error("No active factory contract configured.");

        const web3 = new Web3(
          new Web3.providers.HttpProvider(rpcUrl, {
            timeout: Number(process.env.REACT_APP_RPC_TIMEOUT_MS || 9000),
          })
        );
        const account = web3.eth.accounts.privateKeyToAccount(normalizePrivateKey(bot.privateKey));
        web3.eth.accounts.wallet.add(account);
        web3.eth.defaultAccount = account.address;

        const factory = new web3.eth.Contract(CampaignFactory.abi, factoryAddress);
        const snapshot =
          suppliedSnapshot ||
          (await refreshActiveAuctionRegistry(factoryAddress));
        const now = Math.floor(Date.now() / 1000);
        const me = account.address.toLowerCase();
        const toBotAuction = (auction) => {
          const endTimeSec = Number(auction.endTimeSec || 0);
          const highestBidder = String(auction.highestBidder || "").toLowerCase();
          return {
            ...auction,
            campaign: new web3.eth.Contract(Campaign.abi, auction.address),
            minimumContribution: toBigIntSafe(auction.minimumContribution),
            approversCount: Number(auction.approversCount || 0),
            highestBid: toBigIntSafe(auction.highestBid),
            endTimeSec,
            isActive: !auction.closed && endTimeSec > now,
            secondsLeft: Math.max(0, endTimeSec - now),
            isManager: String(auction.manager || "").toLowerCase() === me,
            isWinner: highestBidder === me,
            myBid: 0n,
          };
        };
        const activeAuctions = (snapshot.activeAuctions || []).map(toBotAuction);
        const finalizableAuctions = (snapshot.finalizableAuctions || []).map(toBotAuction);

        const strategy = getStrategy(bot);

        if (strategy.enableFinalize) {
          for (const auction of finalizableAuctions.filter(
            (item) => item.isManager && item.approversCount > 0
          )) {
            try {
              await sendContractTx(auction.campaign.methods.finalizeAuctionIfNeeded(), {
                from: account.address,
              });
              updateBot(bot.id, (current) => ({
                stats: { ...current.stats, finalized: (current.stats?.finalized || 0) + 1 },
              }));
              addLog("info", `Finalized auction ${auction.address}`, { bot: bot.name });
            } catch (finalizeError) {
              if (isRpcProviderFailure(finalizeError)) {
                coolDownRpcUrl(rpcUrl, finalizeError);
                throw finalizeError;
              }
              addLog("warn", `Finalize failed for ${auction.address}`, {
                bot: bot.name,
                error: finalizeError.message || String(finalizeError),
              });
            }
          }
        }

        if (strategy.enableBidding) {
          let budget = 0n;
          try {
            budget = toBigIntSafe(await factory.methods.getBudget(account.address).call());
          } catch (budgetError) {
            if (isRpcProviderFailure(budgetError)) {
              coolDownRpcUrl(rpcUrl, budgetError);
            }
            throw budgetError;
          }

          const eligible = shuffle(
            activeAuctions.filter((auction) => {
              if (!auction.isActive || auction.isManager) return false;
              if (strategy.skipIfWinning && auction.isWinner) return false;
              if (auction.secondsLeft < strategy.minTimeRemainingSec) return false;
              if (auction.minimumContribution > strategy.maxMinContributionWei) return false;
              const targetBid =
                auction.approversCount === 0 && auction.highestBid === 0n
                  ? auction.minimumContribution
                  : auction.highestBid + strategy.outbidByWei;
              return targetBid <= strategy.maxBidWei;
            }),
          ).slice(0, BOT_CANDIDATES_PER_CYCLE);

          let bidSent = false;
          let lastDecision = { reason: eligible.length ? "No eligible bid" : "No eligible active auctions" };

          for (const candidate of eligible) {
            const candidateKey = candidate.address.toLowerCase();
            if (reservedAuctions?.has(candidateKey)) continue;
            reservedAuctions?.add(candidateKey);

            try {
              candidate.myBid = toBigIntSafe(
                await candidate.campaign.methods.getBid(account.address).call(),
              );
              const decision = getBidDecision(candidate, budget, strategy);
              lastDecision = decision;
              if (!decision.bid) {
                reservedAuctions?.delete(candidateKey);
                continue;
              }

              await sendContractTx(candidate.campaign.methods.contribute(), {
                from: account.address,
                value: decision.amountWei.toString(),
              });
            } catch (bidError) {
              if (isRpcProviderFailure(bidError)) {
                coolDownRpcUrl(rpcUrl, bidError);
                throw bidError;
              }
              addLog("warn", `Bid attempt skipped for ${candidate.address}`, {
                bot: bot.name,
                error: getErrorMessage(bidError),
              });
              reservedAuctions?.delete(candidateKey);
              continue;
            }

            updateBot(bot.id, (current) => ({
              stats: { ...current.stats, bids: (current.stats?.bids || 0) + 1 },
            }));
            addLog("info", `Bid sent by ${bot.name}`, {
              auction: candidate.address,
              amountWei: lastDecision.amountWei.toString(),
            });
            bidSent = true;
            break;
          }

          if (!bidSent) {
            addLog("info", `No bid sent by ${bot.name}: ${lastDecision.reason}`, {
              activeAuctions: activeAuctions.length,
              eligibleAuctions: eligible.length,
              source: snapshot.source,
              budget: budget.toString(),
            });
          }
        }

        updateBot(bot.id, (current) => ({
          status: current.running ? "running" : "stopped",
          wallet: account.address,
          stats: { ...current.stats, cycles: (current.stats?.cycles || 0) + 1 },
        }));
        return true;
      } catch (cycleError) {
        const providerFailure = isRpcProviderFailure(cycleError);
        updateBot(bot.id, (current) => ({
          status: current.running ? "running" : providerFailure ? "stopped" : "error",
          lastError: providerFailure
            ? getFriendlyRpcError(cycleError)
            : getErrorMessage(cycleError),
          stats: {
            ...current.stats,
            errors: providerFailure
              ? current.stats?.errors || 0
              : (current.stats?.errors || 0) + 1,
          },
        }));
        addLog(providerFailure ? "warn" : "error", `Bot cycle failed for ${bot.name}`, {
          error: providerFailure
            ? getFriendlyRpcError(cycleError)
            : getErrorMessage(cycleError),
        });
        return false;
      } finally {
        activeBotCycles.delete(bot.id);
      }
    },
    [addLog, coolDownRpcUrl, getNextRpcUrl, updateBot]
  );

  const runBotsInBatches = useCallback(
    async (selectedBots, limit = selectedBots.length) => {
      const runnableBots = selectedBots
        .filter((bot) => bot.enabled && isValidPrivateKey(bot.privateKey))
        .slice(0, limit);
      const workerCount = Math.min(BOT_MAX_BOTS_PER_TICK, runnableBots.length);
      if (!workerCount) return false;

      if (registryCooldownUntilRef.current > Date.now()) {
        const seconds = Math.max(
          1,
          Math.ceil((registryCooldownUntilRef.current - Date.now()) / 1000),
        );
        setRpcNotice(`Active auction refresh is cooling down. Retrying in about ${seconds}s.`);
        return false;
      }

      const factoryAddress = getActiveFactoryAddress();
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
        setRpcNotice(message);
        addLog(isRpcProviderFailure(snapshotError) ? "warn" : "error", message);
        return false;
      }
      const reservedAuctions = new Set();
      let nextIndex = 0;
      let completedCycles = 0;

      const runWorker = async (workerIndex) => {
        if (workerIndex > 0 && BOT_START_STAGGER_MS > 0) {
          await sleep(workerIndex * BOT_START_STAGGER_MS);
        }

        while (nextIndex < runnableBots.length) {
          const bot = runnableBots[nextIndex];
          nextIndex += 1;
          const completed = await runBotCycle(bot, sharedSnapshot, reservedAuctions);
          if (completed) completedCycles += 1;

          if (BOT_START_STAGGER_MS > 0) {
            await sleep(BOT_START_STAGGER_MS);
          }
        }
      };

      await Promise.all(
        Array.from({ length: workerCount }, (_, workerIndex) => runWorker(workerIndex))
      );
      return completedCycles > 0;
    },
    [addLog, runBotCycle]
  );

  useEffect(() => {
    if (!schedulerEnabled) return undefined;

    const runSchedulerTick = async () => {
      if (schedulerTickRunningRef.current) return;
      schedulerTickRunningRef.current = true;

      try {
        const currentBots = loadStoredBots();
        const dueBots = currentBots.filter((bot) => {
          if (!bot.running || !bot.enabled || !isValidPrivateKey(bot.privateKey)) {
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

    const timer = window.setInterval(runSchedulerTick, BOT_SCHEDULER_TICK_MS);
    runSchedulerTick();

    return () => window.clearInterval(timer);
  }, [runBotsInBatches, schedulerEnabled]);

  const runAction = async (key, action, body = {}) => {
    setActionLoading(key);
    setError("");
    try {
      if (action === "start-network") {
        commitBots((current) =>
          current.map((bot) =>
            bot.enabled && isValidPrivateKey(bot.privateKey)
              ? { ...bot, running: true, status: "running", lastError: null }
              : bot
          )
        );
        toast.success("Enabled bots started in the Admin Zone");
      } else if (action === "stop-network") {
        commitBots((current) =>
          current.map((bot) => ({ ...bot, running: false, status: "stopped" }))
        );
        toast.success("All bots stopped");
      } else if (action === "run-network") {
        const selected = loadStoredBots().filter((bot) => bot.enabled && isValidPrivateKey(bot.privateKey));
        const completed = await runBotsInBatches(selected);
        if (completed) toast.success("Enabled bots ran once");
        else toast.error("No bot cycle completed. Check the connection notice and bot events.");
      } else if (action === "start-bot") {
        updateBot(body.id, { running: true, status: "running", lastError: null });
        toast.success("Bot started");
      } else if (action === "stop-bot") {
        updateBot(body.id, { running: false, status: "stopped" });
        toast.success("Bot stopped");
      } else if (action === "run-bot") {
        const bot = loadStoredBots().find((item) => item.id === body.id);
        const completed = await runBotCycle(bot);
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

          const targetIndex = next.findIndex((bot) => !isValidPrivateKey(bot.privateKey));
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
              Browser-local bots. No external botnet API. Factory: {shortAddress(getActiveFactoryAddress())}
              . Runs up to {BOT_MAX_BOTS_PER_TICK} bots at the same time with RPC backoff.
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
          <Alert severity="info" sx={{ mt: 1.5 }}>
            {rpcNotice}
          </Alert>
        )}

        {error && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
      </Box>

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
              onClick={() => keyFileInputRef.current?.click()}
              disabled={isBusy}
              sx={{ borderRadius: 999 }}
            >
              Upload Keys
            </Button>
            <Button
              variant="contained"
              size="small"
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

        <Box sx={{ display: "grid", gap: 1, mt: 1.5 }}>
          {bots.length ? (
            bots.map((bot) => (
              <Box
                key={bot.id}
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  border: "1px solid #edf0fb",
                  backgroundColor: "#fbfcff",
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) auto" },
                  gap: 1,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                    <Typography variant="body2" sx={{ fontWeight: 800 }}>
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
                      }}
                    >
                      {bot.enabled ? "enabled" : "disabled"}
                    </Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {shortAddress(bot.wallet)} | key {shortKey(bot.privateKey)} | last
                    cycle {formatDate(bot.lastCycleAt)}
                  </Typography>
                  {bot.stats && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      cycles {bot.stats.cycles || 0} | bids {bot.stats.bids || 0} |
                      finalized {bot.stats.finalized || 0} | errors{" "}
                      {bot.stats.errors || 0}
                    </Typography>
                  )}
                  {bot.lastError && (
                    <Typography variant="caption" color="error" display="block">
                      {bot.lastError}
                    </Typography>
                  )}
                </Box>
                <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => runAction(`start-${bot.id}`, "start-bot", { id: bot.id })}
                    disabled={isBusy}
                    sx={{ borderRadius: 999, backgroundColor: "#103090" }}
                  >
                    Start
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => runAction(`run-${bot.id}`, "run-bot", { id: bot.id })}
                    disabled={isBusy}
                    sx={{ borderRadius: 999 }}
                  >
                    Run
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={() => runAction(`stop-${bot.id}`, "stop-bot", { id: bot.id })}
                    disabled={isBusy}
                    sx={{ borderRadius: 999 }}
                  >
                    Stop
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    color="error"
                    onClick={() => runAction(`delete-${bot.id}`, "delete-bot", { id: bot.id })}
                    disabled={isBusy}
                  >
                    Delete
                  </Button>
                </Box>
              </Box>
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
          backgroundColor: "#fbfcff",
          border: "1px solid #e5e9f8",
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 800 }}>
          Recent bot events
        </Typography>
        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: "grid", gap: 0.75, maxHeight: 220, overflow: "auto" }}>
          {logs.length ? (
            logs.slice(0, 20).map((entry, index) => (
              <Typography
                key={`${entry.time}-${index}`}
                variant="caption"
                sx={{ fontFamily: "monospace", color: "#30364f" }}
              >
                [{entry.level}] {entry.time} - {entry.message}
              </Typography>
            ))
          ) : (
            <Typography variant="caption" color="text.secondary">
              No bot events yet.
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default BotnetControlPanel;
