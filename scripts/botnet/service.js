const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const Web3Package = require("web3");
const Web3 = Web3Package.Web3 || Web3Package;

const campaignJson = require("../../src/real_ethereum/build/Campaign.json");
const factoryJson = require("../../src/real_ethereum/build/CampaignFactory.json");
const { loadFactoryAddress } = require("../factoryAddressLoader");

const ROOT_DIR = path.resolve(__dirname, "../..");
const DATA_DIR = path.resolve(process.env.BOTNET_DATA_DIR || path.join(ROOT_DIR, "botnet-data"));
const BOTS_PATH = path.resolve(process.env.BOTNET_BOTS_PATH || path.join(DATA_DIR, "bots.json"));
const LOG_PATH = path.resolve(process.env.BOTNET_LOG_PATH || path.join(DATA_DIR, "botnet.log"));
const DEFAULT_PORT = Number(process.env.BOTNET_PORT || process.env.PORT || 3002);
const LEGACY_BOTNET_BOTS_PATH =
  process.env.BOTNET_LEGACY_BOTS_PATH ||
  "C:\\Users\\Programmers\\Desktop\\bc_SUPERBOT\\files\\data\\bots.json";

const DEFAULT_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
];

const DEFAULT_OVERRIDES = {
  AUTO_TRADE_INTERVAL_SEC: "60",
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

function loadSeedBotsFromEnv() {
  if (!process.env.BOTNET_BOTS_JSON) return [];
  const parsed = JSON.parse(process.env.BOTNET_BOTS_JSON);
  return Array.isArray(parsed) ? parsed.map(normalizeBotRecord) : [];
}

function loadBots() {
  try {
    const raw = fs.readFileSync(BOTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeBotRecord) : [];
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
    return Array.isArray(parsed) ? parsed.map(normalizeBotRecord) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function saveBots(bots) {
  ensureDataDir();
  fs.writeFileSync(BOTS_PATH, `${JSON.stringify(bots, null, 2)}\n`, "utf8");
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
  const validPrivateKey = isValidPrivateKey(privateKey);
  return {
    id: String(input.id || createBotId(input.name)).trim(),
    name: String(input.name || "Bot").trim(),
    privateKey,
    enabled: validPrivateKey && toBool(input.enabled, true),
    overrides: {
      ...DEFAULT_OVERRIDES,
      ...(input.overrides || {}),
    },
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    importWarning:
      input.importWarning ||
      (validPrivateKey ? "" : "Private key is missing or invalid; bot disabled."),
  };
}

function getBotWalletAddress(bot) {
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
  const configurationError = isValidPrivateKey(bot.privateKey)
    ? bot.importWarning || ""
    : "Private key is missing or invalid.";
  return {
    id: bot.id,
    name: bot.name,
    enabled: bot.enabled,
    overrides: bot.overrides,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    status: configurationError ? "invalid-config" : state.status || "stopped",
    running: Boolean(state.timer),
    wallet: state.wallet || getBotWalletAddress(bot),
    lastCycleAt: state.lastCycleAt || null,
    lastError: configurationError || state.lastError || null,
    stats: state.stats || { cycles: 0, bids: 0, finalized: 0, errors: 0 },
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

  if (!isValidPrivateKey(next.privateKey)) {
    throw new Error("Each bot needs a valid 0x private key.");
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

    let target = bots.find((bot) => !isValidPrivateKey(bot.privateKey));
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

function buildContext(bot) {
  if (!isValidPrivateKey(bot.privateKey)) {
    throw new Error(`Bot ${bot.name} has an invalid private key.`);
  }

  const rpcUrl = getRpcUrls()[0];
  if (!rpcUrl) throw new Error("Missing BOTNET_RPC_URL/RPC_URL/INFURA_KEY.");

  const web3 = new Web3(rpcUrl);
  const account = web3.eth.accounts.privateKeyToAccount(normalizePrivateKey(bot.privateKey));
  web3.eth.accounts.wallet.add(account);
  web3.eth.defaultAccount = account.address;

  const factoryAddress = getFactoryAddress();
  const factory = new web3.eth.Contract(factoryJson.abi, factoryAddress);

  return { web3, account, factory, factoryAddress, rpcUrl };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAuctions(ctx, bot) {
  const now = Math.floor(Date.now() / 1000);
  const me = ctx.account.address.toLowerCase();
  const addresses = await ctx.factory.methods.getDeployedCampaigns().call();
  const auctions = [];

  for (const address of addresses) {
    try {
      const campaign = new ctx.web3.eth.Contract(campaignJson.abi, address);
      const [summary, closed, myBid] = await Promise.all([
        campaign.methods.getSummary().call(),
        campaign.methods.getStatus().call().catch(() => false),
        campaign.methods.getBid(ctx.account.address).call().catch(() => "0"),
      ]);
      const endTimeSec = Number(summary[9]);
      const highestBidder = String(summary[7] || "").toLowerCase();

      auctions.push({
        address,
        campaign,
        minimumContribution: asBigInt(summary[0]),
        balance: asBigInt(summary[1]),
        approversCount: Number(summary[2] || 0),
        manager: summary[3],
        highestBid: asBigInt(summary[4]),
        dataForSell: summary[5],
        dataDescription: summary[6],
        highestBidder: summary[7],
        bidderAddresses: summary[8] || [],
        endTimeSec,
        closed: Boolean(closed),
        isActive: endTimeSec > now,
        secondsLeft: Math.max(0, endTimeSec - now),
        isManager: String(summary[3] || "").toLowerCase() === me,
        isWinner: highestBidder === me,
        myBid: asBigInt(myBid),
        botName: bot.name,
      });
    } catch (error) {
      log("warn", `Bot skipped unreadable auction ${address}`, {
        bot: bot.name,
        error: error.message || String(error),
      });
    }
  }

  return auctions;
}

async function fetchBudget(ctx) {
  try {
    const budget = asBigInt(await ctx.factory.methods.getBudget(ctx.account.address).call());
    if (budget > 0n) return budget;
  } catch (_) {}

  const balance = await ctx.web3.eth.getBalance(ctx.account.address);
  return asBigInt(balance);
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
  };
}

function pickBidCandidate(auctions) {
  const open = auctions.filter((auction) => auction.isActive);
  const notWinning = open.filter((auction) => !auction.isWinner);
  const pool = notWinning.length ? notWinning : open;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getBidDecision(auction, budget, strategy) {
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

  if (targetBid > strategy.maxBidWei) {
    return { bid: false, reason: "Target bid exceeds max bid" };
  }
  if (incrementalValue <= 0n) {
    return { bid: false, reason: "Existing bid already covers target" };
  }
  if (incrementalValue > budget) {
    return { bid: false, reason: "Insufficient budget" };
  }

  return { bid: true, amountWei: incrementalValue, targetBid };
}

async function sendContractTx(ctx, method, options) {
  let gas = 2500000;
  try {
    gas = await method.estimateGas(options);
  } catch (_) {}
  return method.send({
    ...options,
    gas: Math.ceil(Number(gas) * 1.2),
  });
}

async function runBotCycle(idOrBot) {
  const bot = typeof idOrBot === "string"
    ? loadBots().find((item) => item.id === idOrBot)
    : idOrBot;
  if (!bot) throw new Error("Bot not found.");

  const state = getRuntimeState(bot.id);
  if (state.cycleRunning) {
    log("warn", `Skipped overlapping cycle for ${bot.name}`, { id: bot.id });
    return serializeBot(bot);
  }

  state.cycleRunning = true;
  state.status = state.timer ? "running-cycle" : "running-cycle";
  state.lastCycleAt = new Date().toISOString();
  state.lastError = null;
  state.stats.cycles += 1;

  try {
    const ctx = buildContext(bot);
    state.wallet = ctx.account.address;
    const strategy = getStrategy(bot);
    const auctions = await fetchAuctions(ctx, bot);

    if (strategy.enableFinalize) {
      for (const auction of auctions.filter(
        (item) => !item.isActive && !item.closed && item.isManager && item.approversCount > 0
      )) {
        try {
          await sendContractTx(ctx, auction.campaign.methods.finalizeAuctionIfNeeded(), {
            from: ctx.account.address,
          });
          state.stats.finalized += 1;
          log("info", `Finalized auction ${auction.address}`, { bot: bot.name });
          await wait(1000);
        } catch (error) {
          state.stats.errors += 1;
          log("warn", `Finalize failed for ${auction.address}`, {
            bot: bot.name,
            error: error.message || String(error),
          });
        }
      }
    }

    if (strategy.enableBidding) {
      const budget = await fetchBudget(ctx);
      const candidate = pickBidCandidate(auctions);
      const decision = getBidDecision(candidate, budget, strategy);

      if (decision.bid) {
        await sendContractTx(ctx, candidate.campaign.methods.contribute(), {
          from: ctx.account.address,
          value: decision.amountWei.toString(),
        });
        state.stats.bids += 1;
        log("info", `Bid sent by ${bot.name}`, {
          auction: candidate.address,
          amountWei: decision.amountWei.toString(),
        });
      } else {
        log("info", `No bid sent by ${bot.name}: ${decision.reason}`);
      }
    }
  } catch (error) {
    state.stats.errors += 1;
    state.lastError = error.message || String(error);
    log("error", `Bot cycle failed for ${bot.name}`, { error: state.lastError });
  } finally {
    state.cycleRunning = false;
    state.status = state.timer ? "running" : "stopped";
  }

  return serializeBot(bot);
}

function getRuntimeState(id) {
  const existing = runtime.get(id);
  if (existing) return existing;

  const next = {
    timer: null,
    status: "stopped",
    wallet: null,
    lastCycleAt: null,
    lastError: null,
    cycleRunning: false,
    stats: { cycles: 0, bids: 0, finalized: 0, errors: 0 },
  };
  runtime.set(id, next);
  return next;
}

async function startBot(id) {
  const bot = loadBots().find((item) => item.id === id);
  if (!bot) throw new Error("Bot not found.");
  if (!isValidPrivateKey(bot.privateKey)) {
    throw new Error(`Bot ${bot.name} has an invalid private key.`);
  }

  const state = getRuntimeState(id);
  if (state.timer) return serializeBot(bot);

  const intervalSec = getStrategy(bot).intervalSec;
  state.status = "running";
  state.timer = setInterval(() => {
    runBotCycle(bot.id).catch((error) => {
      state.lastError = error.message || String(error);
      state.stats.errors += 1;
    });
  }, intervalSec * 1000);

  log("info", `Started bot ${bot.name}`, { id, intervalSec });
  runBotCycle(bot.id).catch((error) => {
    state.lastError = error.message || String(error);
    state.stats.errors += 1;
  });
  return serializeBot(bot);
}

async function stopBot(id) {
  const state = getRuntimeState(id);
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.status = "stopped";
  log("info", `Stopped bot ${id}`);
  const bot = loadBots().find((item) => item.id === id);
  return bot ? serializeBot(bot) : { ok: true };
}

async function startEnabledBots() {
  const bots = loadBots().filter((bot) => bot.enabled && isValidPrivateKey(bot.privateKey));
  for (const bot of bots) {
    await startBot(bot.id);
  }
  return getBotNetworkStatus();
}

async function stopAllBots() {
  const ids = [...runtime.keys()];
  for (const id of ids) {
    await stopBot(id);
  }
  return getBotNetworkStatus();
}

function selectBots(scope = "running") {
  const bots = loadBots();
  if (scope === "all") return bots.filter((bot) => isValidPrivateKey(bot.privateKey));
  if (scope === "enabled") {
    return bots.filter((bot) => bot.enabled && isValidPrivateKey(bot.privateKey));
  }
  return bots.filter((bot) => runtime.get(bot.id)?.timer);
}

async function runSelectedBotsOnce(scope = "running") {
  const bots = selectBots(scope);
  const results = [];
  for (const bot of bots) {
    results.push(await runBotCycle(bot));
  }
  return { ok: true, triggered: results.length, bots: results };
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
  getBotNetworkStatus,
  getLogs,
  loadBots,
  runBotCycle,
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
