/* global BigInt */
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const Web3Package = require("web3");
const Web3 = Web3Package.Web3 || Web3Package;

const campaignJson = require("../../src/real_ethereum/build/Campaign.json");
const factoryJson = require("../../src/real_ethereum/build/CampaignFactory.json");
const { loadFactoryAddress } = require("../factoryAddressLoader");
const { createMetaMaskAgentWallet } = require("./metamaskAgentWallet");

const PRIVATE_KEY_WALLET = "private-key";
const METAMASK_AGENT_WALLET = "metamask-agent";

const ROOT_DIR = path.resolve(__dirname, "../..");
const DATA_DIR = path.resolve(process.env.BOTNET_DATA_DIR || path.join(ROOT_DIR, "botnet-data"));
const BOTS_PATH = path.resolve(process.env.BOTNET_BOTS_PATH || path.join(DATA_DIR, "bots.json"));
const LOG_PATH = path.resolve(process.env.BOTNET_LOG_PATH || path.join(DATA_DIR, "botnet.log"));
const AUCTION_INDEX_PATH = path.resolve(
  process.env.BOTNET_AUCTION_INDEX_PATH || path.join(DATA_DIR, "active-auctions.json"),
);
const DEFAULT_PORT = Number(process.env.BOTNET_PORT || process.env.PORT || 3002);
const LEGACY_BOTNET_BOTS_PATH =
  process.env.BOTNET_LEGACY_BOTS_PATH ||
  "C:\\Users\\Programmers\\Desktop\\bc_SUPERBOT\\files\\data\\bots.json";

const DEFAULT_RPC_URLS = [
  "https://rpc.sepolia.org",
];

const DEFAULT_OVERRIDES = {
  AUTO_TRADE_INTERVAL_SEC: "60",
  MAX_BIDS_PER_CYCLE: "1",
  MAX_BID_WEI: "2000",
  OUTBID_BY_WEI: "10",
  MAX_MIN_CONTRIBUTION_WEI: "2000",
  MIN_TIME_REMAINING_SEC: "20",
  SKIP_IF_WINNING: "true",
  ENABLE_BIDDING: "true",
  ENABLE_FINALIZE: "true",
};

const runtime = new Map();
const memoryLog = [];
const providerCache = new Map();
const rpcCooldowns = new Map();
const campaignCache = new Map();
const walletAccountCache = new Map();
const walletQueues = new Map();
const cyclePlannerPromise = import(
  pathToFileURL(path.join(ROOT_DIR, "src", "botnet", "cyclePlanner.mjs")).href
);
const NODE_SCHEDULER_TICK_MS = Math.max(2500, Number(process.env.BOTNET_SCHEDULER_TICK_MS || 5000));
const AUCTION_SNAPSHOT_TTL_MS = Math.max(5000, Number(process.env.BOTNET_AUCTION_TTL_MS || 15000));
const FULL_RECONCILE_MS = Math.max(60000, Number(process.env.BOTNET_FULL_RECONCILE_MS || 5 * 60 * 1000));
const RECONCILE_PAGE_SIZE = Math.max(20, Number(process.env.BOTNET_RECONCILE_PAGE_SIZE || 40));
const EVENT_BLOCK_WINDOW = Math.max(100, Number(process.env.BOTNET_EVENT_BLOCK_WINDOW || 2000));
const READ_BATCH_SIZE = Math.max(5, Number(process.env.BOTNET_READ_BATCH_SIZE || 25));
const MAX_CONCURRENT_WRITES = Math.max(1, Number(process.env.BOTNET_MAX_CONCURRENT_WRITES || 3));
const FINALIZE_INTERVAL_MS = Math.max(15000, Number(process.env.BOTNET_FINALIZE_INTERVAL_MS || 30000));
const ENDED_VERIFICATION_GRACE_SEC = Math.max(
  30,
  Number(process.env.BOTNET_AUCTION_END_GRACE_SEC || 120),
);
let auctionIndexCache = null;
let auctionIndexRefresh = null;
let networkTimer = null;
let networkCycleRunning = false;
let allocationCursor = 0;
let lastFinalizeAt = 0;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function log(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    meta,
  };
  memoryLog.unshift(entry);
  if (memoryLog.length > 250) memoryLog.length = 250;

  try {
    ensureDataDir();
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (_) {}

  const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[botnet:${level}] ${message}${extras}`
  );
}

function getLogs(limit = 80) {
  return memoryLog.slice(0, limit);
}

function normalizePrivateKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function isValidPrivateKey(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(normalizePrivateKey(value));
}

function normalizeWalletType(value) {
  return value === METAMASK_AGENT_WALLET ? METAMASK_AGENT_WALLET : PRIVATE_KEY_WALLET;
}

function isMetaMaskAgentBot(bot) {
  return normalizeWalletType(bot?.walletType) === METAMASK_AGENT_WALLET;
}

function isBotConfigured(bot) {
  return isMetaMaskAgentBot(bot) || isValidPrivateKey(bot?.privateKey);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function asBigInt(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") return value;
    if (value && typeof value.toString === "function") return BigInt(value.toString());
    return BigInt(value || "0");
  } catch (_) {
    return fallback;
  }
}

function createBotId(name = "bot") {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 18) || "bot";
  return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

function ensureSingleMetaMaskAgentBot(bots = []) {
  const normalized = bots.map(normalizeBotRecord);
  if (normalized.length < 4) return normalized;

  const existingAgentIndex = normalized.findIndex(isMetaMaskAgentBot);
  const agentIndex = existingAgentIndex >= 0 ? existingAgentIndex : 3;
  return normalized.map((bot, index) => {
    if (index === agentIndex) {
      return normalizeBotRecord({
        ...bot,
        name: existingAgentIndex >= 0 ? bot.name : "MetaMask Wallet Agent",
        walletType: METAMASK_AGENT_WALLET,
        importWarning: "",
      });
    }
    if (!isMetaMaskAgentBot(bot)) return bot;
    return normalizeBotRecord({ ...bot, walletType: PRIVATE_KEY_WALLET, importWarning: "" });
  });
}

function loadSeedBotsFromEnv() {
  if (!process.env.BOTNET_BOTS_JSON) return [];
  const parsed = JSON.parse(process.env.BOTNET_BOTS_JSON);
  return Array.isArray(parsed) ? ensureSingleMetaMaskAgentBot(parsed) : [];
}

function loadBots() {
  try {
    const raw = fs.readFileSync(BOTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? ensureSingleMetaMaskAgentBot(parsed) : [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const envBots = loadSeedBotsFromEnv();
  if (envBots.length) {
    saveBots(envBots);
    return envBots;
  }

  seedBotsFromLegacyIfNeeded();

  try {
    const raw = fs.readFileSync(BOTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? ensureSingleMetaMaskAgentBot(parsed) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function saveBots(bots) {
  ensureDataDir();
  fs.writeFileSync(
    BOTS_PATH,
    `${JSON.stringify(ensureSingleMetaMaskAgentBot(bots), null, 2)}\n`,
    "utf8",
  );
}

function importLegacyBots({ force = false } = {}) {
  if (!force && fs.existsSync(BOTS_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(BOTS_PATH, "utf8"));
      if (Array.isArray(existing) && existing.length > 0) {
        return { imported: 0, skipped: true, bots: existing.map(normalizeBotRecord) };
      }
    } catch (_) {}
  }

  if (!fs.existsSync(LEGACY_BOTNET_BOTS_PATH)) {
    return { imported: 0, skipped: true, bots: [], error: "Legacy bot file not found." };
  }

  const imported = JSON.parse(fs.readFileSync(LEGACY_BOTNET_BOTS_PATH, "utf8"));
  if (!Array.isArray(imported) || imported.length === 0) {
    return { imported: 0, skipped: true, bots: [], error: "Legacy bot file is empty." };
  }

  const bots = imported.map((bot, index) =>
    normalizeBotRecord({
      ...bot,
      id: bot.id || `imported-bot-${index + 1}`,
    })
  );
  saveBots(bots);
  log("info", `Imported ${bots.length} bot(s) from legacy botnet data`, {
    source: LEGACY_BOTNET_BOTS_PATH,
    target: BOTS_PATH,
  });
  return { imported: bots.length, skipped: false, bots };
}

function seedBotsFromLegacyIfNeeded() {
  if (fs.existsSync(BOTS_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(BOTS_PATH, "utf8"));
      if (Array.isArray(existing) && existing.length > 0) return;
    } catch (_) {}
  }

  if (!fs.existsSync(LEGACY_BOTNET_BOTS_PATH)) return;

  try {
    importLegacyBots();
  } catch (error) {
    log("warn", "Could not seed bots from legacy botnet data", {
      source: LEGACY_BOTNET_BOTS_PATH,
      error: error.message || String(error),
    });
  }
}

function normalizeBotRecord(input = {}) {
  const privateKey = normalizePrivateKey(input.privateKey);
  const walletType = normalizeWalletType(input.walletType);
  const validPrivateKey = isValidPrivateKey(privateKey);
  const configured = walletType === METAMASK_AGENT_WALLET || validPrivateKey;
  return {
    id: String(input.id || createBotId(input.name)).trim(),
    name: String(input.name || "Bot").trim(),
    walletType,
    privateKey,
    wallet: String(input.wallet || "").trim(),
    enabled: configured && toBool(input.enabled, true),
    overrides: {
      ...DEFAULT_OVERRIDES,
      ...(input.overrides || {}),
    },
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    importWarning:
      input.importWarning ||
      (configured ? "" : "Private key is missing or invalid; bot disabled."),
  };
}

function getBotWalletAddress(bot) {
  if (isMetaMaskAgentBot(bot)) return bot.wallet || null;
  if (!isValidPrivateKey(bot.privateKey)) return null;
  try {
    const web3 = new Web3();
    return web3.eth.accounts.privateKeyToAccount(
      normalizePrivateKey(bot.privateKey)
    ).address;
  } catch (_) {
    return null;
  }
}

function serializeBot(bot) {
  const state = runtime.get(bot.id) || {};
  const configurationError = isBotConfigured(bot)
    ? bot.importWarning || ""
    : "Private key is missing or invalid.";
  return {
    id: bot.id,
    name: bot.name,
    walletType: normalizeWalletType(bot.walletType),
    enabled: bot.enabled,
    overrides: bot.overrides,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    status: configurationError ? "invalid-config" : state.status || "stopped",
    running: Boolean(state.running),
    wallet: state.wallet || getBotWalletAddress(bot),
    lastCycleAt: state.lastCycleAt || null,
    lastError: configurationError || state.lastError || null,
    stats: state.stats || { cycles: 0, bids: 0, finalized: 0, errors: 0 },
    lastCycleMetrics: state.lastCycleMetrics || null,
  };
}

function getBotNetworkStatus() {
  const bots = loadBots().map(serializeBot);
  return {
    ok: true,
    bots,
    summary: bots.reduce(
      (summary, bot) => {
        summary.registered += 1;
        summary.enabled += bot.enabled ? 1 : 0;
        summary.running += bot.running ? 1 : 0;
        summary.cycles += bot.stats?.cycles || 0;
        summary.bids += bot.stats?.bids || 0;
        summary.finalized += bot.stats?.finalized || 0;
        summary.errors += bot.stats?.errors || 0;
        return summary;
      },
      { registered: 0, enabled: 0, running: 0, cycles: 0, bids: 0, finalized: 0, errors: 0 }
    ),
  };
}

function saveBot(input = {}) {
  const bots = loadBots();
  const existing = input.id ? bots.find((bot) => bot.id === input.id) : null;
  const next = normalizeBotRecord({
    ...existing,
    ...input,
    privateKey: input.privateKey || existing?.privateKey,
    overrides: {
      ...(existing?.overrides || DEFAULT_OVERRIDES),
      ...(input.overrides || {}),
    },
    id: input.id || existing?.id || createBotId(input.name),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (!isBotConfigured(next)) {
    throw new Error("Each bot needs a valid private key or Agent Wallet configuration.");
  }

  const index = bots.findIndex((bot) => bot.id === next.id);
  if (index >= 0) {
    bots[index] = next;
  } else {
    bots.push(next);
  }

  saveBots(bots);
  log("info", `Saved bot ${next.name}`, { id: next.id });
  return serializeBot(next);
}

function getUniquePrivateKeys(values = []) {
  const seen = new Set();
  const keys = [];

  values.forEach((value) => {
    const key = normalizePrivateKey(value);
    const lower = key.toLowerCase();
    if (!isValidPrivateKey(key) || seen.has(lower)) return;
    seen.add(lower);
    keys.push(key);
  });

  return keys;
}

function extractPrivateKeysFromText(text = "") {
  const matches = [...String(text).matchAll(/(?:^|[^a-fA-F0-9])((?:0x)?[a-fA-F0-9]{64})(?=$|[^a-fA-F0-9])/g)];
  return getUniquePrivateKeys(matches.map((match) => match[1]));
}

function smartAssignPrivateKeys(input = {}) {
  const uploadedKeys = getUniquePrivateKeys([
    ...(Array.isArray(input.privateKeys) ? input.privateKeys : []),
    ...extractPrivateKeysFromText(input.rawText || ""),
  ]);

  if (!uploadedKeys.length) {
    throw new Error("No valid 0x private keys were found.");
  }

  const bots = loadBots();
  const existingKeyOwners = new Map();
  bots.forEach((bot) => {
    const key = normalizePrivateKey(bot.privateKey).toLowerCase();
    if (isValidPrivateKey(key)) existingKeyOwners.set(key, bot.id);
  });

  const assigned = [];
  const skipped = [];
  let createdCount = 0;

  uploadedKeys.forEach((privateKey) => {
    const lower = privateKey.toLowerCase();
    const duplicateOwner = existingKeyOwners.get(lower);
    if (duplicateOwner) {
      skipped.push({
        reason: "duplicate",
        botId: duplicateOwner,
      });
      return;
    }

    let target = bots.find(
      (bot) => !isMetaMaskAgentBot(bot) && !isValidPrivateKey(bot.privateKey)
    );
    if (!target) {
      createdCount += 1;
      target = normalizeBotRecord({
        id: createBotId(`uploaded-bot-${createdCount}`),
        name: `Uploaded Bot ${bots.length + 1}`,
        enabled: true,
        privateKey: "",
      });
      bots.push(target);
    }

    target.privateKey = privateKey;
    target.enabled = true;
    target.importWarning = "";
    target.updatedAt = new Date().toISOString();
    target.overrides = {
      ...DEFAULT_OVERRIDES,
      ...(target.overrides || {}),
    };
    existingKeyOwners.set(lower, target.id);
    assigned.push({
      botId: target.id,
      botName: target.name,
      created: target.name.startsWith("Uploaded Bot"),
    });
  });

  saveBots(bots);
  log("info", `Smart-assigned ${assigned.length} uploaded bot private key(s)`, {
    assigned: assigned.length,
    skipped: skipped.length,
  });

  return {
    assigned,
    skipped,
    bots: bots.map(serializeBot),
    summary: {
      uploaded: uploadedKeys.length,
      assigned: assigned.length,
      skipped: skipped.length,
      registered: bots.length,
    },
  };
}

async function deleteBot(id) {
  await stopBot(id);
  const bots = loadBots().filter((bot) => bot.id !== id);
  saveBots(bots);
  runtime.delete(id);
  log("info", `Deleted bot ${id}`);
  return { ok: true };
}

function getRpcUrls() {
  const csvValues = [
    process.env.BOTNET_RPC_URLS,
    process.env.RPC_URLS,
    process.env.REACT_APP_RPC_URLS,
  ];
  const directValues = [
    process.env.BOTNET_RPC_URL,
    process.env.RPC_URL,
    process.env.INFURA_KEY ? `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}` : "",
    ...DEFAULT_RPC_URLS,
  ];
  const urls = [
    ...csvValues.flatMap((value) =>
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    ),
    ...directValues.filter(Boolean),
  ];
  return [...new Set(urls)];
}

function getFactoryAddress() {
  return (
    process.env.BOTNET_FACTORY_ADDRESS ||
    process.env.FACTORY_ADDRESS ||
    loadFactoryAddress({
      rootDir: ROOT_DIR,
      market: process.env.BOTNET_FACTORY_MARKET || process.env.FACTORY_MARKET || "production",
    })
  );
}

function getRpcFailureKind(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (/chain is not available|free plan|upgrade to paid|unsupported chain/.test(message)) {
    return "unsupported-plan";
  }
  if (/rate limit|too many requests|usage limit|higher limits|429/.test(message)) {
    return "capacity";
  }
  if (/timeout|timed out|failed to fetch|network error|connection|cooling down|no healthy rpc/.test(message)) {
    return "network";
  }
  return "other";
}

function isProviderFailure(error) {
  return getRpcFailureKind(error) !== "other";
}

function coolDownProvider(rpcUrl, error) {
  const kind = getRpcFailureKind(error);
  const duration = kind === "unsupported-plan" ? 24 * 60 * 60 * 1000 : kind === "network" ? 15000 : 45000;
  rpcCooldowns.set(rpcUrl, Date.now() + duration);
  let provider = rpcUrl;
  try {
    provider = new URL(rpcUrl).hostname;
  } catch (_) {}
  log("warn", "RPC endpoint entered cooldown", { provider, kind });
}

function getProviderContext(factoryAddress = getFactoryAddress()) {
  const urls = getRpcUrls();
  const rpcUrl = urls.find((url) => Number(rpcCooldowns.get(url) || 0) <= Date.now());
  if (!rpcUrl) throw new Error("All configured RPC endpoints are cooling down.");
  const key = `${rpcUrl}:${factoryAddress.toLowerCase()}`;
  if (!providerCache.has(key)) {
    const web3 = new Web3(rpcUrl);
    providerCache.set(key, {
      rpcUrl,
      web3,
      factoryAddress,
      factory: new web3.eth.Contract(factoryJson.abi, factoryAddress),
    });
  }
  return providerCache.get(key);
}

function getCachedCampaign(ctx, address) {
  const key = `${ctx.rpcUrl}:${String(address).toLowerCase()}`;
  if (!campaignCache.has(key)) {
    campaignCache.set(key, new ctx.web3.eth.Contract(campaignJson.abi, address));
  }
  return campaignCache.get(key);
}

function executeBatch(ctx, methods, blockNumber = "latest") {
  if (!methods.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const batch = new ctx.web3.BatchRequest();
    const results = new Array(methods.length);
    let remaining = methods.length;
    methods.forEach((method, index) => {
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
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const item = queue.shift();
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}

const withWriteSlot = createSemaphore(MAX_CONCURRENT_WRITES);

function enqueueWalletWrite(address, task) {
  const key = String(address || "").toLowerCase();
  const previous = walletQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => withWriteSlot(task));
  const tracked = current.finally(() => {
    if (walletQueues.get(key) === tracked) walletQueues.delete(key);
  });
  walletQueues.set(key, tracked);
  return current;
}

function normalizeIndexedAuction(auction = {}) {
  return {
    address: String(auction.address || ""),
    minimumContribution: String(auction.minimumContribution || "0"),
    approversCount: Number(auction.approversCount || 0),
    manager: String(auction.manager || ""),
    highestBid: String(auction.highestBid || "0"),
    highestBidder: String(auction.highestBidder || ""),
    endTimeSec: Number(auction.endTimeSec || 0),
    closed: Boolean(auction.closed),
  };
}

function loadAuctionIndex() {
  if (auctionIndexCache) return auctionIndexCache;
  try {
    auctionIndexCache = JSON.parse(fs.readFileSync(AUCTION_INDEX_PATH, "utf8"));
  } catch (_) {
    auctionIndexCache = null;
  }
  return auctionIndexCache;
}

function saveAuctionIndex(index) {
  ensureDataDir();
  const tempPath = `${AUCTION_INDEX_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, AUCTION_INDEX_PATH);
  auctionIndexCache = index;
  return index;
}

function classifyIndexedAuctions(auctions, nowSec = Math.floor(Date.now() / 1000)) {
  const unique = new Map();
  auctions.map(normalizeIndexedAuction).forEach((auction) => {
    if (auction.address) unique.set(auction.address.toLowerCase(), auction);
  });
  const values = [...unique.values()];
  return {
    activeAuctions: values.filter((auction) => !auction.closed && auction.endTimeSec > nowSec),
    finalizableAuctions: values.filter((auction) =>
      !auction.closed && auction.endTimeSec > 0 && auction.endTimeSec <= nowSec &&
      (auction.approversCount > 0 ||
        auction.endTimeSec + ENDED_VERIFICATION_GRACE_SEC > nowSec),
    ).slice(0, 100),
  };
}

async function readIndexedSummaries(ctx, addresses, blockNumber) {
  const auctions = [];
  const failed = [];
  for (let offset = 0; offset < addresses.length; offset += READ_BATCH_SIZE) {
    const chunk = addresses.slice(offset, offset + READ_BATCH_SIZE);
    const results = await executeBatch(
      ctx,
      chunk.map((address) => getCachedCampaign(ctx, address).methods.getListSummary()),
      blockNumber,
    );
    results.forEach((result, index) => {
      if (result?.status !== "fulfilled") {
        failed.push(chunk[index]);
        return;
      }
      const value = result.value;
      auctions.push(normalizeIndexedAuction({
        address: chunk[index],
        minimumContribution: value[0],
        approversCount: value[2],
        manager: value[3],
        highestBid: value[4],
        highestBidder: value[6],
        endTimeSec: value[7],
        closed: value[8],
      }));
    });
  }
  return { auctions, failed };
}

async function performNodeAuctionIndexRefresh(ctx, { force = false } = {}) {
  const cached = loadAuctionIndex();
  if (
    !force &&
    cached?.factoryAddress?.toLowerCase() === ctx.factoryAddress.toLowerCase() &&
    Date.now() - Number(cached.updatedAt || 0) < AUCTION_SNAPSHOT_TTL_MS
  ) {
    return { ...cached, cacheHit: true, rpcBatches: 0, logicalReads: 0 };
  }

  const blockNumber = Number(await ctx.web3.eth.getBlockNumber());
  const sameFactory = cached?.factoryAddress?.toLowerCase() === ctx.factoryAddress.toLowerCase();
  const previous = sameFactory ? cached : null;
  let allAddresses = Array.isArray(previous?.allAddresses) ? previous.allAddresses : [];
  let eventCursor = Number(previous?.eventCursor || 0);
  const discovered = [];

  if (!eventCursor || !allAddresses.length) {
    allAddresses = await ctx.factory.methods.getDeployedCampaigns().call();
    eventCursor = blockNumber;
  } else if (eventCursor < blockNumber) {
    const toBlock = Math.min(blockNumber, eventCursor + EVENT_BLOCK_WINDOW);
    const events = await ctx.factory.getPastEvents("AuctionCreatedDetailed", {
      fromBlock: eventCursor + 1,
      toBlock,
    });
    events.forEach((event) => {
      const address = event.returnValues?.campaignAddress || event.returnValues?.[0];
      if (address) discovered.push(address);
    });
    eventCursor = toBlock;
    allAddresses = [...new Set([...allAddresses, ...discovered])];
  }

  const reconciliationDue =
    !previous?.lastFullReconcileAt ||
    Date.now() - Number(previous.lastFullReconcileAt || 0) >= FULL_RECONCILE_MS ||
    Number(previous?.reconcileCursor || 0) > 0;
  const reconcileCursor = reconciliationDue ? Number(previous?.reconcileCursor || 0) : 0;
  const reconcileEnd = reconciliationDue
    ? Math.min(allAddresses.length, reconcileCursor + RECONCILE_PAGE_SIZE)
    : reconcileCursor;
  const tracked = [
    ...(previous?.activeAuctions || []),
    ...(previous?.finalizableAuctions || []),
  ];
  const candidates = [...new Set([
    ...tracked.map((auction) => auction.address),
    ...discovered,
    ...(reconciliationDue ? allAddresses.slice(reconcileCursor, reconcileEnd) : []),
    ...(!previous ? allAddresses : []),
  ])].filter(Boolean);
  const summaryResult = await readIndexedSummaries(ctx, candidates, blockNumber);
  const failedSet = new Set(summaryResult.failed.map((address) => address.toLowerCase()));
  const preserved = tracked.filter((auction) => failedSet.has(auction.address.toLowerCase()));
  const classified = classifyIndexedAuctions([...preserved, ...summaryResult.auctions]);
  const reconcileComplete = reconciliationDue && reconcileEnd >= allAddresses.length;
  const index = saveAuctionIndex({
    version: 1,
    factoryAddress: ctx.factoryAddress,
    updatedAt: Date.now(),
    blockNumber,
    eventCursor,
    allAddresses,
    knownAddressCount: allAddresses.length,
    reconcileCursor: reconciliationDue && !reconcileComplete ? reconcileEnd : 0,
    lastFullReconcileAt: reconcileComplete ? Date.now() : Number(previous?.lastFullReconcileAt || 0),
    unreadableCount: summaryResult.failed.length,
    ...classified,
  });
  return {
    ...index,
    cacheHit: false,
    logicalReads: 2 + candidates.length,
    rpcBatches: 1 + Math.ceil(candidates.length / READ_BATCH_SIZE),
  };
}

async function refreshNodeAuctionIndex(ctx, options = {}) {
  if (auctionIndexRefresh) return auctionIndexRefresh;
  auctionIndexRefresh = performNodeAuctionIndexRefresh(ctx, options).finally(() => {
    auctionIndexRefresh = null;
  });
  return auctionIndexRefresh;
}

async function syncNodeAuctionIndex() {
  let lastError;
  for (let attempt = 0; attempt < Math.min(3, getRpcUrls().length); attempt += 1) {
    const context = getProviderContext();
    try {
      return await refreshNodeAuctionIndex(context, { force: true });
    } catch (error) {
      lastError = error;
      if (!isProviderFailure(error)) throw error;
      coolDownProvider(context.rpcUrl, error);
    }
  }
  throw lastError || new Error("No healthy RPC endpoint is available.");
}

async function buildBotContext(sharedContext, bot) {
  if (!isBotConfigured(bot)) {
    throw new Error(`Bot ${bot.name} has an invalid wallet configuration.`);
  }
  let account;
  let agentWallet = null;
  if (isMetaMaskAgentBot(bot)) {
    agentWallet = createMetaMaskAgentWallet();
    await agentWallet.assertReady();
    account = { address: await agentWallet.getAddress() };
  } else {
    const cacheKey = `${bot.id}:${normalizePrivateKey(bot.privateKey).toLowerCase()}`;
    account = walletAccountCache.get(cacheKey);
    if (!account) {
      account = sharedContext.web3.eth.accounts.privateKeyToAccount(
        normalizePrivateKey(bot.privateKey),
      );
      walletAccountCache.set(cacheKey, account);
    }
    if (!sharedContext.web3.eth.accounts.wallet[account.address]) {
      sharedContext.web3.eth.accounts.wallet.add(account);
    }
  }
  return {
    ...sharedContext,
    account,
    agentWallet,
    signerType: isMetaMaskAgentBot(bot) ? METAMASK_AGENT_WALLET : PRIVATE_KEY_WALLET,
  };
}

function getStrategy(bot) {
  const overrides = bot.overrides || {};
  return {
    maxBidWei: BigInt(overrides.MAX_BID_WEI || DEFAULT_OVERRIDES.MAX_BID_WEI),
    outbidByWei: BigInt(overrides.OUTBID_BY_WEI || DEFAULT_OVERRIDES.OUTBID_BY_WEI),
    maxMinContributionWei: BigInt(
      overrides.MAX_MIN_CONTRIBUTION_WEI || DEFAULT_OVERRIDES.MAX_MIN_CONTRIBUTION_WEI
    ),
    minTimeRemainingSec: toPositiveInt(
      overrides.MIN_TIME_REMAINING_SEC,
      Number(DEFAULT_OVERRIDES.MIN_TIME_REMAINING_SEC)
    ),
    skipIfWinning: toBool(overrides.SKIP_IF_WINNING, true),
    enableBidding: toBool(overrides.ENABLE_BIDDING, true),
    enableFinalize: toBool(overrides.ENABLE_FINALIZE, true),
    intervalSec: toPositiveInt(
      overrides.AUTO_TRADE_INTERVAL_SEC,
      Number(DEFAULT_OVERRIDES.AUTO_TRADE_INTERVAL_SEC)
    ),
    maxBidsPerCycle: Math.min(
      5,
      Math.max(1, toPositiveInt(overrides.MAX_BIDS_PER_CYCLE, 1)),
    ),
  };
}

async function sendContractTx(ctx, contractAddress, method, options, intent) {
  let gas = 2500000;
  try {
    gas = await method.estimateGas(options);
  } catch (_) {}
  const gasWithBuffer = Math.ceil(Number(gas) * 1.2);
  if (ctx.signerType === METAMASK_AGENT_WALLET) {
    return ctx.agentWallet.sendTransaction({
      to: contractAddress,
      data: method.encodeABI(),
      value: options.value || "0",
      gas: gasWithBuffer,
      intent,
    });
  }
  return method.send({
    ...options,
    gas: gasWithBuffer,
  });
}

function updateIndexedAuction(index, address, patch) {
  const key = String(address).toLowerCase();
  const combined = [
    ...(index.activeAuctions || []),
    ...(index.finalizableAuctions || []),
  ];
  const next = combined.map((auction) =>
    auction.address.toLowerCase() === key ? normalizeIndexedAuction({ ...auction, ...patch }) : auction,
  );
  const classified = classifyIndexedAuctions(next);
  return saveAuctionIndex({ ...index, updatedAt: Date.now(), ...classified });
}

async function refreshAffectedAuction(ctx, index, address) {
  const result = await readIndexedSummaries(ctx, [address], "latest");
  if (!result.auctions.length) return index;
  return updateIndexedAuction(index, address, result.auctions[0]);
}

async function executeRoundOnProvider(bots, sharedContext) {
  const planner = await cyclePlannerPromise;
  const startedAt = Date.now();
  let index = await refreshNodeAuctionIndex(sharedContext);
  const blockNumber = index.blockNumber;
  const nowSec = Math.floor(Date.now() / 1000);
  const botContexts = [];

  for (const bot of bots) {
    const state = getRuntimeState(bot.id);
    try {
      const ctx = await buildBotContext(sharedContext, bot);
      state.wallet = ctx.account.address;
      botContexts.push({ bot, ctx, state, strategy: getStrategy(bot) });
    } catch (error) {
      state.lastError = error.message || String(error);
      state.stats.errors += 1;
      state.status = state.running ? "running" : "stopped";
    }
  }

  const allocation = planner.allocateCycleCandidates({
    bots: botContexts
      .filter(({ strategy }) => strategy.enableBidding)
      .map(({ bot, ctx, strategy }) => ({ id: bot.id, wallet: ctx.account.address, strategy })),
    auctions: index.activeAuctions,
    cursor: allocationCursor,
    nowSec,
    reservePerSlot: 1,
  });
  allocationCursor = allocation.nextCursor;

  const reads = [];
  botContexts.forEach(({ bot, ctx }) => {
    reads.push({ botId: bot.id, kind: "budget", method: sharedContext.factory.methods.getBudget(ctx.account.address) });
    const assignment = allocation.assignments[bot.id] || { primary: [], reserve: [] };
    [...assignment.primary, ...assignment.reserve].forEach((auction) => {
      reads.push({
        botId: bot.id,
        kind: "bid",
        auctionAddress: auction.address,
        method: getCachedCampaign(sharedContext, auction.address).methods.getBid(ctx.account.address),
      });
    });
  });

  const readResults = [];
  for (let offset = 0; offset < reads.length; offset += READ_BATCH_SIZE) {
    const chunk = reads.slice(offset, offset + READ_BATCH_SIZE);
    const results = await executeBatch(sharedContext, chunk.map((item) => item.method), blockNumber);
    results.forEach((result, indexInChunk) => readResults.push({ ...chunk[indexInChunk], result }));
  }
  const budgets = new Map();
  const myBids = new Map();
  readResults.forEach((item) => {
    if (item.result.status !== "fulfilled") return;
    if (item.kind === "budget") budgets.set(item.botId, asBigInt(item.result.value));
    if (item.kind === "bid") {
      myBids.set(`${item.botId}:${item.auctionAddress.toLowerCase()}`, asBigInt(item.result.value));
    }
  });

  const sharedMetrics = {
    snapshotAgeMs: Math.max(0, Date.now() - Number(index.updatedAt || Date.now())),
    activeAuctions: index.activeAuctions.length,
    logicalReads: Number(index.logicalReads || 0) + reads.length,
    rpcBatches: Number(index.rpcBatches || 0) + Math.ceil(reads.length / READ_BATCH_SIZE),
    candidatesEvaluated: allocation.candidatesEvaluated,
    cacheHits: index.cacheHit ? 1 : 0,
  };

  await runWithConcurrency(botContexts, async ({ bot, ctx, state, strategy }) => {
    const metrics = planner.createEmptyCycleMetrics(startedAt);
    Object.assign(metrics, sharedMetrics);
    state.cycleRunning = true;
    state.status = "running-cycle";
    state.lastCycleAt = new Date().toISOString();
    state.lastError = null;
    state.stats.cycles += 1;
    let budget = budgets.get(bot.id) || 0n;
    let sent = 0;
    const skipped = [];
    const assignment = allocation.assignments[bot.id] || { primary: [], reserve: [] };
    const slots = assignment.primary.map((primary, slot) => [primary, assignment.reserve[slot]].filter(Boolean));

    try {
      if (!strategy.enableBidding) skipped.push("Bidding disabled");
      if (strategy.enableBidding && !budgets.has(bot.id)) skipped.push("Budget read unavailable");
      for (const candidates of slots) {
        if (!state.running || !budgets.has(bot.id) || sent >= strategy.maxBidsPerCycle) break;
        let slotCompleted = false;
        for (const candidate of candidates) {
          if (!state.running || slotCompleted) break;
          const dynamicAuction = {
            ...candidate,
            isActive: !candidate.closed && candidate.endTimeSec > Math.floor(Date.now() / 1000),
            secondsLeft: Math.max(0, candidate.endTimeSec - Math.floor(Date.now() / 1000)),
            isManager: candidate.manager.toLowerCase() === ctx.account.address.toLowerCase(),
            isWinner: candidate.highestBidder.toLowerCase() === ctx.account.address.toLowerCase(),
            myBid: myBids.get(`${bot.id}:${candidate.address.toLowerCase()}`) || 0n,
          };
          if (!myBids.has(`${bot.id}:${candidate.address.toLowerCase()}`)) {
            skipped.push("Candidate bid read unavailable");
            continue;
          }
          const decision = planner.getBidDecision(dynamicAuction, budget, strategy);
          if (!decision.bid) {
            skipped.push(decision.reason);
            continue;
          }
          metrics.bidsAttempted += 1;
          try {
            await enqueueWalletWrite(ctx.account.address, async () => {
              if (!state.running) throw Object.assign(new Error("Bot stopped before queued write."), { cancelled: true });
              const campaign = getCachedCampaign(sharedContext, candidate.address);
              return sendContractTx(
                ctx,
                candidate.address,
                campaign.methods.contribute(),
                { from: ctx.account.address, value: decision.amountWei.toString() },
                `Place a ${decision.amountWei.toString()} wei bid on auction ${candidate.address}`,
              );
            });
            budget -= decision.amountWei;
            sent += 1;
            slotCompleted = true;
            metrics.bidsSent += 1;
            state.stats.bids += 1;
            index = updateIndexedAuction(index, candidate.address, {
              highestBid: decision.targetBid.toString(),
              highestBidder: ctx.account.address,
              approversCount: Math.max(1, Number(candidate.approversCount || 0)),
            });
            log("info", `Bid sent by ${bot.name}`, {
              auction: candidate.address,
              amountWei: decision.amountWei.toString(),
            });
          } catch (error) {
            if (error.cancelled) {
              skipped.push("Stopped before queued write");
              break;
            }
            if (isProviderFailure(error)) {
              coolDownProvider(sharedContext.rpcUrl, error);
              state.lastError = error.message || String(error);
              skipped.push("RPC provider unavailable");
              break;
            }
            skipped.push("Auction state changed");
            index = await refreshAffectedAuction(sharedContext, index, candidate.address);
            log("warn", `Bid deferred after stale state for ${candidate.address}`, {
              bot: bot.name,
              error: error.message || String(error),
            });
          }
        }
      }
    } finally {
      metrics.skippedReason = sent ? "" : skipped[0] || (index.activeAuctions.length ? "No eligible candidate" : "No active auctions");
      state.lastCycleMetrics = planner.finishCycleMetrics(metrics);
      state.cycleRunning = false;
      state.status = state.running ? "running" : "stopped";
    }
  }, Math.max(1, Number(process.env.BOTNET_MAX_CONCURRENT_BOTS || 4)));

  if (Date.now() - lastFinalizeAt >= FINALIZE_INTERVAL_MS) {
    lastFinalizeAt = Date.now();
    const finalizers = new Map(
      botContexts
        .filter(({ state, strategy }) => state.running && strategy.enableFinalize)
        .map((item) => [item.ctx.account.address.toLowerCase(), item]),
    );
    for (const auction of index.finalizableAuctions.slice(0, 2)) {
      const owner = finalizers.get(auction.manager.toLowerCase());
      if (!owner) continue;
      try {
        await enqueueWalletWrite(owner.ctx.account.address, () => {
          if (!owner.state.running) {
            throw Object.assign(new Error("Bot stopped before queued finalization."), { cancelled: true });
          }
          return sendContractTx(
            owner.ctx,
            auction.address,
            getCachedCampaign(sharedContext, auction.address).methods.finalizeAuctionIfNeeded(),
            { from: owner.ctx.account.address },
            `Finalize ended auction ${auction.address}`,
          );
        });
        owner.state.stats.finalized += 1;
        index = updateIndexedAuction(index, auction.address, { closed: true });
        log("info", `Finalized auction ${auction.address}`, { bot: owner.bot.name });
      } catch (error) {
        if (error.cancelled) continue;
        if (isProviderFailure(error)) {
          coolDownProvider(sharedContext.rpcUrl, error);
          owner.state.lastError = error.message || String(error);
          continue;
        }
        owner.state.stats.errors += 1;
        log("warn", `Finalize failed for ${auction.address}`, {
          bot: owner.bot.name,
          error: error.message || String(error),
        });
      }
    }
  }

  return botContexts.map(({ bot }) => serializeBot(bot));
}

async function runCoordinatedCycle(inputBots) {
  const bots = (inputBots || []).filter(isBotConfigured);
  if (!bots.length) return [];
  if (networkCycleRunning) {
    log("warn", "Skipped overlapping coordinated bot cycle");
    return bots.map(serializeBot);
  }
  networkCycleRunning = true;
  let lastError;
  try {
    for (let attempt = 0; attempt < Math.min(3, getRpcUrls().length); attempt += 1) {
      const sharedContext = getProviderContext();
      try {
        return await executeRoundOnProvider(bots, sharedContext);
      } catch (error) {
        lastError = error;
        if (!isProviderFailure(error)) throw error;
        coolDownProvider(sharedContext.rpcUrl, error);
      }
    }
    throw lastError || new Error("No healthy RPC endpoint is available.");
  } catch (error) {
    bots.forEach((bot) => {
      const state = getRuntimeState(bot.id);
      state.lastError = error.message || String(error);
      if (!isProviderFailure(error)) state.stats.errors += 1;
      state.cycleRunning = false;
      state.status = state.running ? "running" : "stopped";
    });
    log(isProviderFailure(error) ? "warn" : "error", "Coordinated bot cycle failed", {
      error: error.message || String(error),
    });
    return bots.map(serializeBot);
  } finally {
    networkCycleRunning = false;
  }
}

async function runBotCycle(idOrBot) {
  const bot = typeof idOrBot === "string"
    ? loadBots().find((item) => item.id === idOrBot)
    : idOrBot;
  if (!bot) throw new Error("Bot not found.");
  const state = getRuntimeState(bot.id);
  const wasRunning = state.running;
  state.running = true;
  const [result] = await runCoordinatedCycle([bot]);
  state.running = wasRunning;
  state.status = state.running ? "running" : "stopped";
  return serializeBot(bot);
}

function getRuntimeState(id) {
  const existing = runtime.get(id);
  if (existing) return existing;

  const next = {
    running: false,
    status: "stopped",
    wallet: null,
    lastCycleAt: null,
    lastError: null,
    cycleRunning: false,
    lastCycleMetrics: null,
    stats: { cycles: 0, bids: 0, finalized: 0, errors: 0 },
  };
  runtime.set(id, next);
  return next;
}

async function startBot(id) {
  const bot = loadBots().find((item) => item.id === id);
  if (!bot) throw new Error("Bot not found.");
  if (!isBotConfigured(bot)) {
    throw new Error(`Bot ${bot.name} is not configured with a usable wallet.`);
  }

  const state = getRuntimeState(id);
  if (state.running) return serializeBot(bot);
  const intervalSec = getStrategy(bot).intervalSec;
  state.running = true;
  state.status = "running";
  ensureNetworkScheduler();
  log("info", `Started bot ${bot.name}`, { id, intervalSec });
  runDueBots().catch((error) => log("error", "Network scheduler failed", { error: error.message }));
  return serializeBot(bot);
}

async function stopBot(id) {
  const state = getRuntimeState(id);
  state.running = false;
  state.status = "stopped";
  log("info", `Stopped bot ${id}`);
  const bot = loadBots().find((item) => item.id === id);
  return bot ? serializeBot(bot) : { ok: true };
}

async function startEnabledBots() {
  const bots = loadBots().filter((bot) => bot.enabled && isBotConfigured(bot));
  bots.forEach((bot) => {
    const state = getRuntimeState(bot.id);
    state.running = true;
    state.status = "running";
  });
  ensureNetworkScheduler();
  await runCoordinatedCycle(bots);
  return getBotNetworkStatus();
}

async function stopAllBots() {
  runtime.forEach((state) => {
    state.running = false;
    state.status = "stopped";
  });
  if (networkTimer) clearInterval(networkTimer);
  networkTimer = null;
  return getBotNetworkStatus();
}

function selectBots(scope = "running") {
  const bots = loadBots();
  if (scope === "all") return bots.filter(isBotConfigured);
  if (scope === "enabled") {
    return bots.filter((bot) => bot.enabled && isBotConfigured(bot));
  }
  return bots.filter((bot) => runtime.get(bot.id)?.running);
}

async function runWithConcurrency(items, worker, maxConcurrent = 4) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(maxConcurrent) || 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

async function runSelectedBotsOnce(scope = "running") {
  const bots = selectBots(scope);
  const prior = bots.map((bot) => [bot.id, getRuntimeState(bot.id).running]);
  bots.forEach((bot) => { getRuntimeState(bot.id).running = true; });
  const results = await runCoordinatedCycle(bots);
  prior.forEach(([id, running]) => {
    const state = getRuntimeState(id);
    state.running = running;
    state.status = running ? "running" : "stopped";
  });
  return { ok: true, triggered: results.length, bots: results };
}

async function runDueBots() {
  const now = Date.now();
  const due = loadBots().filter((bot) => {
    const state = getRuntimeState(bot.id);
    if (!bot.enabled || !state.running || state.cycleRunning || !isBotConfigured(bot)) return false;
    const last = state.lastCycleAt ? Date.parse(state.lastCycleAt) : 0;
    return now - last >= getStrategy(bot).intervalSec * 1000;
  });
  if (due.length) await runCoordinatedCycle(due);
  return due.length;
}

function ensureNetworkScheduler() {
  if (networkTimer) return networkTimer;
  const tick = async () => {
    try {
      await syncNodeAuctionIndex();
      await runDueBots();
    } catch (error) {
      log(isProviderFailure(error) ? "warn" : "error", "Network scheduler failed", {
        error: error.message || String(error),
      });
    }
  };
  networkTimer = setInterval(() => {
    tick();
  }, NODE_SCHEDULER_TICK_MS);
  networkTimer.unref?.();
  tick();
  return networkTimer;
}

function json(res, data, status = 200, cors = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...cors,
  });
  res.end(JSON.stringify(data, null, 2));
}

function getCorsHeaders(req) {
  const configured = process.env.BOTNET_CORS_ORIGIN;
  return {
    "Access-Control-Allow-Origin": configured || req.headers.origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Botnet-Token",
  };
}

function normalizeEndpoint(url) {
  const pathname = new URL(url, "http://botnet.local").pathname;
  return pathname
    .replace(/^\/api\/botnet/, "")
    .replace(/^\/api/, "")
    .replace(/\/$/, "") || "/";
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

function assertToken(req) {
  const token = process.env.BOTNET_ADMIN_TOKEN;
  if (!token) return;
  if (req.headers["x-botnet-token"] !== token) {
    throw Object.assign(new Error("Unauthorized botnet request."), { status: 401 });
  }
}

async function handleApi(req, res, cors) {
  const endpoint = normalizeEndpoint(req.url);
  if (req.method !== "GET" || endpoint !== "/health") {
    assertToken(req);
  }

  if (req.method === "GET" && endpoint === "/health") {
    return json(res, { ok: true, service: "bc-botnet", time: new Date().toISOString() }, 200, cors);
  }

  if (req.method === "GET" && endpoint === "/status") {
    return json(res, {
      ok: true,
      service: "bc-botnet",
      factoryAddress: getFactoryAddress(),
      dataPath: BOTS_PATH,
      ...getBotNetworkStatus(),
    }, 200, cors);
  }

  if (req.method === "GET" && endpoint === "/bots") {
    return json(res, getBotNetworkStatus(), 200, cors);
  }

  if (req.method === "GET" && endpoint === "/logs") {
    return json(res, { ok: true, logs: getLogs() }, 200, cors);
  }

  const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

  if (req.method === "POST" && endpoint === "/bots") {
    return json(res, { ok: true, bot: saveBot(body) }, 200, cors);
  }

  if (req.method === "POST" && endpoint === "/bots/private-keys") {
    const result = smartAssignPrivateKeys(body);
    return json(res, { ok: true, ...result }, 200, cors);
  }

  if (req.method === "POST" && endpoint === "/import-legacy") {
    const result = importLegacyBots({ force: body.force === true });
    return json(res, { ok: true, ...result, ...getBotNetworkStatus() }, 200, cors);
  }

  if (req.method === "POST" && endpoint === "/bots/delete") {
    return json(res, await deleteBot(body.id), 200, cors);
  }

  if (req.method === "POST" && endpoint === "/bots/start") {
    return json(res, { ok: true, bot: await startBot(body.id) }, 200, cors);
  }

  if (req.method === "POST" && endpoint === "/bots/stop") {
    return json(res, { ok: true, bot: await stopBot(body.id) }, 200, cors);
  }

  if (req.method === "POST" && endpoint === "/bots/run-once") {
    return json(res, { ok: true, bot: await runBotCycle(body.id) }, 200, cors);
  }

  if (req.method === "POST" && endpoint === "/start-network") {
    return json(res, await startEnabledBots(), 200, cors);
  }

  if (req.method === "POST" && endpoint === "/stop-network") {
    return json(res, await stopAllBots(), 200, cors);
  }

  if (req.method === "POST" && endpoint === "/run-network") {
    return json(res, await runSelectedBotsOnce(body.scope || "running"), 200, cors);
  }

  return json(res, { ok: false, error: "Not found" }, 404, cors);
}

function startServer(port = DEFAULT_PORT) {
  ensureDataDir();
  const server = http.createServer(async (req, res) => {
    const cors = getCorsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

    try {
      await handleApi(req, res, cors);
    } catch (error) {
      log("error", "Botnet API error", { error: error.message || String(error) });
      json(res, { ok: false, error: error.message || String(error) }, error.status || 500, cors);
    }
  });

  server.listen(port, () => {
    log("info", `BC botnet service listening on ${port}`, {
      api: `/api/botnet`,
      dataPath: BOTS_PATH,
    });
  });
  return server;
}

module.exports = {
  BOTS_PATH,
  classifyIndexedAuctions,
  enqueueWalletWrite,
  getBotNetworkStatus,
  getLogs,
  loadBots,
  isBotConfigured,
  isMetaMaskAgentBot,
  ensureSingleMetaMaskAgentBot,
  normalizeBotRecord,
  getStrategy,
  getRpcFailureKind,
  runCoordinatedCycle,
  runBotCycle,
  runWithConcurrency,
  runSelectedBotsOnce,
  saveBot,
  smartAssignPrivateKeys,
  startBot,
  startEnabledBots,
  startServer,
  stopAllBots,
  stopBot,
  importLegacyBots,
};
