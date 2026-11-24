"use strict";
// Scheduled seller bots for the Sapphire marketplace. A pure core (runSellerJob: injected store / chain / secret / clock)
// plus the Lambda entry point (sellerJob). Bots create auctions only while real participants are on the site.
//
// Guarantees
//  * Idle runs (disabled, or nothing to create or finalize) read one config item and one progress item: no scan, no secret.
//  * One run at a time (DynamoDB lease). Each bot works sequentially with its own nonce.
//  * Never more auctions than `quantity` per item, even across crashes: every attempt is a record created with
//    attribute_not_exists (sellerbot#<bot>#item#<slot>#seq#<n>) BEFORE anything is signed. A record left in "sending" is settled by
//    receipt or nonce on a later run; only a record that provably never reached the chain is released for reuse.
//  * Calldata of createCampaign must be Sapphire-enveloped (the chain adapter reports it; the core refuses anything else).
//  * Logs are JSON events with bot ids, item slots, auction addresses, tx hashes, reasons and counts. Never payloads, keys,
//    proofs, passwords, pid hashes, participant addresses or raw error text (errors are reduced to a short code).
const { minBalanceWei } = require("./sellerConfig");

const DEFAULTS = {
  budgetMs: 100_000, leaseSeconds: 150, maxFinalizePerRun: 3, receiptWaitMs: 40_000, pollMs: 1500, maxErrors: 3,
  createGas: 3_000_000n, finalizeGas: 600_000n, absentSeconds: 300, finalizeMarginSeconds: 5,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const classifyError = (error) => {
  if (typeof error?.sellerCode === "string") return error.sellerCode;
  const text = `${error?.code || ""} ${error?.message || ""}`;
  if (/insufficient funds|insufficient balance/i.test(text)) return "insufficient_funds";
  if (/nonce/i.test(text)) return "nonce";
  if (/revert|CALL_EXCEPTION/i.test(text)) return "revert";
  if (/timeout|ETIMEDOUT|ECONN|ENOTFOUND|network|SERVER_ERROR|fetch|socket/i.test(text)) return "rpc";
  return "unknown";
};
const coded = (code) => Object.assign(new Error(code), { sellerCode: code });
const DEFINITE_REJECTION = /insufficient funds|nonce too low|underpriced|exceeds block gas|invalid sender|intrinsic gas/i;
const ALREADY_KNOWN = /already known|known transaction|already imported/i;
const HASH = /^0x[0-9a-fA-F]{64}$/;

const runSellerJob = async ({ store, chain, getSecret, now = () => Date.now(), log = console.log, settings = {}, holder = `run-${Math.random().toString(36).slice(2)}` }) => {
  const cfg = { ...DEFAULTS, ...settings };
  const event = (name, fields = {}) => log(JSON.stringify({ event: name, ...fields }));
  const startedMs = now();
  const nowSec = () => Math.floor(now() / 1000);
  const remainingMs = () => cfg.budgetMs - (now() - startedMs);

  let stored;
  let progress;
  try {
    stored = await store.getConfig();
    progress = (await store.getProgress()) || {};
  } catch {
    event("seller_error", { stage: "read_config", code: "store" });
    return { status: "error" };
  }
  const config = stored?.config;
  progress.bots = progress.bots || {};
  progress.addresses = progress.addresses || {};
  const hintKey = (item) => `${item.slot}.${item.seqBase}`;
  const stateOf = (id) => (progress.bots[id] = progress.bots[id] || { errors: 0, hints: {}, open: [] });
  const hasLeft = (bot) => bot.items.some((item) => (stateOf(bot.id).hints[hintKey(item)] || 0) < item.quantity);

  // a. Idle skip: one config read, no scan, no secret.
  if (!config || config.enabled !== true) { event("seller_idle_skip", { reason: "disabled" }); return { status: "idle", reason: "disabled" }; }
  const running = (config.bots || []).filter((bot) => bot.running === true);
  const needCreate = running.some(hasLeft);
  const needFinalize = running.some((bot) => stateOf(bot.id).open.length > 0);
  if (!needCreate && !needFinalize) { event("seller_idle_skip", { reason: "nothing_to_do" }); return { status: "idle", reason: "nothing_to_do" }; }

  // b. Lease: one run at a time.
  if (!(await store.acquireLease(holder, nowSec(), nowSec() + cfg.leaseSeconds))) { event("seller_lease_held"); return { status: "locked" }; }
  const result = { status: "ran", created: 0, finalized: 0, errors: 0, paused: 0 };
  try {
    // c. Presence (only when something could be created).
    let active = false;
    if (needCreate) {
      const presence = await evaluatePresence();
      active = presence.state === "active";
      event("seller_presence", { state: presence.state, count: presence.count, mode: config.presenceMode });
    }
    if (!active && !needFinalize) { await store.putProgress(progress); event("seller_idle_skip", { reason: "no_participants" }); return { status: "idle", reason: "no_participants" }; }

    // d. Secret, once per container (the entry point caches it).
    const secret = await getSecret();
    const keys = Object.fromEntries((secret?.bots || []).filter((bot) => bot && typeof bot.id === "string" && typeof bot.privateKey === "string").map((bot) => [bot.id, bot.privateKey]));
    const addresses = {};
    for (const [id, key] of Object.entries(keys)) addresses[id] = chain.addressOf(key);
    if (JSON.stringify(progress.addresses) !== JSON.stringify(addresses)) progress.addresses = addresses;

    // e. Bots, one after the other.
    for (const bot of running) {
      if (remainingMs() < 5000) { event("seller_time_budget"); break; }
      await processBot(bot, keys[bot.id], addresses[bot.id], active, result);
    }
    progress.lastRunAt = nowSec();
    await store.putProgress(progress);
    event("seller_run", { created: result.created, finalized: result.finalized, errors: result.errors, active });
    return result;
  } finally {
    await store.releaseLease(holder).catch(() => {});
  }

  async function evaluatePresence() {
    const previous = progress.presence?.state;
    const record = (state, count) => { progress.presence = { mode: config.presenceMode, state, count, checkedAt: nowSec() }; return progress.presence; };
    if (config.presenceMode === "always") return record("active", null);
    const exclude = new Set(Object.values(progress.addresses || {}).map((address) => String(address).toLowerCase()));
    let count;
    try {
      count = await store.countPresence({ sinceSeconds: nowSec() - config.activeWindowMinutes * 60, exclude });
    } catch {
      event("seller_error", { stage: "presence", code: "scan" });
      return record("unknown", null); // fail closed: an unknown presence never sells
    }
    if (count >= config.minActiveParticipants) { progress.zeroSince = null; return record("active", count); }
    if (progress.zeroSince == null) progress.zeroSince = nowSec();
    // Within the grace period after having been active the market still counts as active (a short gap is not "idle").
    const withinGrace = previous === "active" && nowSec() - progress.zeroSince < config.idleGraceMinutes * 60;
    return record(withinGrace ? "active" : "idle", count);
  }

  async function waitReceipt(hash, maxMs) {
    const deadline = now() + Math.max(0, Math.min(maxMs, remainingMs() - 2000));
    for (;;) {
      const receipt = await chain.getReceipt(hash);
      if (receipt) return receipt;
      if (now() >= deadline) return null;
      await cfg.sleep(cfg.pollMs);
    }
  }

  async function pause(bot, code) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await store.getConfig();
      if (!current?.config) return;
      const next = structuredClone(current.config);
      const target = next.bots.find((entry) => entry.id === bot.id);
      if (!target) return;
      target.running = false;
      target.lastError = code;
      if (await store.putConfig(next, current.version)) break;
    }
    result.paused += 1;
    event("seller_paused", { bot: bot.id, reason: code });
  }

  // Decides what a record left in "sending" by an earlier run turned into. Returns "created" | "released" | "reverted" | "pending".
  async function settle(bot, record, address) {
    const mark = (fields, expect = "sending") => store.updateRecord(bot.id, record.item, record.seq, fields, expect);
    if (!HASH.test(record.txHash || "")) { await mark({ status: "released" }); return "released"; } // never signed to the end: nothing can reach the chain
    const finish = async (receipt) => {
      if (receipt.status !== 1) { await mark({ status: "released" }); return "reverted"; }
      const created = chain.parseCreated(receipt);
      await mark({ status: "created", ...(created?.auction ? { auction: created.auction, endTime: created.endTime } : {}) });
      return "created";
    };
    const receipt = await chain.getReceipt(record.txHash);
    if (receipt) return finish(receipt);
    if (await chain.getTransaction(record.txHash)) return "pending";
    const latestNonce = await chain.getNonce(address, "latest");
    const lateReceipt = await chain.getReceipt(record.txHash); // mined between the two reads?
    if (lateReceipt) return finish(lateReceipt);
    // The raw transaction is never stored, so a transaction that is absent AND whose nonce was used by another one (or that
    // stayed absent past the Lambda timeout) can never be mined any more: the slot is free again.
    if (latestNonce > Number(record.nonce) || nowSec() - Number(record.sendingAt || 0) > cfg.absentSeconds) { await mark({ status: "released" }); return "released"; }
    return "pending";
  }

  async function trackOpen(st, record) {
    if (record.status === "created" && record.auction && !record.finalized && !st.open.some((entry) => entry.address === record.auction)) {
      st.open.push({ item: record.item, seq: record.seq, address: record.auction, endTime: record.endTime });
    }
  }

  async function finalizeEnded(bot, st, key, address, result) {
    let done = 0;
    for (const entry of [...st.open]) {
      if (done >= cfg.maxFinalizePerRun || remainingMs() < 15_000) break;
      if (nowSec() < Number(entry.endTime) + cfg.finalizeMarginSeconds) continue;
      const markDone = async () => {
        await store.updateRecord(bot.id, entry.item, entry.seq, { finalized: true });
        st.open = st.open.filter((open) => open.address !== entry.address);
      };
      if ((await chain.getAuction(entry.address)).closed) { await markDone(); continue; }
      const [nonce, gasPrice] = await Promise.all([chain.getNonce(address, "pending"), chain.getGasPrice()]);
      const signed = await chain.signFinalize({ key, auction: entry.address, nonce, gasPrice: (gasPrice * 12n) / 10n, gasLimit: cfg.finalizeGas });
      done += 1;
      await chain.sendRaw(signed.rawTx).catch((error) => { if (!ALREADY_KNOWN.test(String(error?.message))) throw error; });
      const receipt = await waitReceipt(signed.txHash, 30_000);
      if (receipt?.status === 1 || (await chain.getAuction(entry.address)).closed) {
        await markDone();
        result.finalized += 1;
        event("seller_finalized", { bot: bot.id, item: entry.item, auction: entry.address, txHash: signed.txHash });
      } else if (receipt) {
        throw coded("revert");
      }
    }
  }

  // Finds (and takes) the next free sequence number of an item. Returns { seq, n } | { blocked } | { exhausted }.
  async function takeSlot(bot, st, item, address) {
    const hk = hintKey(item);
    let contiguous = true;
    let n = (st.hints[hk] || 0) + 1;
    while (n <= item.quantity) {
      const seq = item.seqBase + n;
      let record = await store.getRecord(bot.id, item.slot, seq);
      if (!record) {
        const fresh = { botId: bot.id, item: item.slot, seq, status: "sending", createdAt: nowSec(), sendingAt: nowSec() };
        if (await store.createRecord(fresh)) return { seq, n };
        continue; // lost a race: read it again
      }
      if (record.status === "sending") {
        const outcome = await settle(bot, record, address);
        if (outcome === "pending") return { blocked: true };
        if (outcome === "reverted") throw coded("revert");
        record = { ...record, status: outcome };
      }
      if (record.status === "released") {
        if (await store.updateRecord(bot.id, item.slot, seq, { status: "sending", sendingAt: nowSec(), txHash: "none", nonce: 0 }, "released")) return { seq, n };
        continue;
      }
      await trackOpen(st, record); // consumed (created): remember it for finalization if an earlier run lost track
      if (contiguous) st.hints[hk] = n; else contiguous = false;
      n += 1;
    }
    return { exhausted: true };
  }

  async function create(bot, st, key, address, balance, result) {
    const order = bot.items.map((_, index) => (index + (st.nextItem || 0)) % bot.items.length);
    for (const index of order) {
      const item = bot.items[index];
      if ((st.hints[hintKey(item)] || 0) >= item.quantity) continue;
      const slot = await takeSlot(bot, st, item, address);
      if (slot.blocked) return "in_flight";
      if (slot.exhausted) { st.hints[hintKey(item)] = item.quantity; continue; }
      const mark = (fields, expect = "sending") => store.updateRecord(bot.id, item.slot, slot.seq, fields, expect);
      const release = () => mark({ status: "released" }).catch(() => {});
      let signed;
      try {
        const [nonce, quoted] = await Promise.all([chain.getNonce(address, "pending"), chain.getGasPrice()]);
        const gasPrice = (quoted * 12n) / 10n;
        if (balance < gasPrice * cfg.createGas) { await release(); return "low_balance"; }
        signed = await chain.signCreate({ key, minimum: item.minimumBid, dataSell: item.payload, dataDesc: item.description, duration: item.durationMinutes, nonce, gasPrice, gasLimit: cfg.createGas });
        if (signed.enveloped !== true) throw coded("not_enveloped");
        if (!(await mark({ nonce, txHash: signed.txHash, sendingAt: nowSec() }))) throw coded("record_lost");
      } catch (error) {
        await release();
        throw error;
      }
      st.nextItem = (index + 1) % bot.items.length;
      try {
        await chain.sendRaw(signed.rawTx);
      } catch (error) {
        if (!ALREADY_KNOWN.test(String(error?.message))) {
          if (DEFINITE_REJECTION.test(String(error?.message))) await release(); // the node refused it: nothing was broadcast
          throw error; // anything else is ambiguous: the record stays "sending" and is settled by receipt or nonce
        }
      }
      st.lastCreateAt = nowSec();
      const receipt = await waitReceipt(signed.txHash, cfg.receiptWaitMs);
      if (!receipt) { event("seller_pending", { bot: bot.id, item: item.slot, txHash: signed.txHash }); return "pending"; }
      if (receipt.status !== 1) { await release(); throw coded("revert"); }
      const created = chain.parseCreated(receipt);
      await mark({ status: "created", ...(created?.auction ? { auction: created.auction, endTime: created.endTime } : {}) });
      if (created?.auction) st.open.push({ item: item.slot, seq: slot.seq, address: created.auction, endTime: created.endTime });
      if (slot.n === (st.hints[hintKey(item)] || 0) + 1) st.hints[hintKey(item)] = slot.n;
      result.created += 1;
      event("seller_created", { bot: bot.id, item: item.slot, auction: created?.auction, txHash: signed.txHash });
      return "created";
    }
    return "no_items_left";
  }

  async function processBot(bot, key, address, active, result) {
    const st = stateOf(bot.id);
    if (!key) { st.errors += 1; st.lastError = "no_key"; event("seller_error", { bot: bot.id, stage: "key", code: "no_key" }); result.errors += 1; if (st.errors >= cfg.maxErrors) await pause(bot, "no_key"); return; }
    let stage = "start";
    try {
      stage = "balance";
      const balance = await chain.getBalance(address);
      st.balanceWei = balance.toString();
      stage = "finalize";
      await finalizeEnded(bot, st, key, address, result);
      if (active) {
        stage = "create";
        const open = st.open.filter((entry) => Number(entry.endTime) > nowSec()).length;
        let skip = null;
        if (open >= bot.maxConcurrentOpen) skip = "max_open";
        else if (nowSec() - (st.lastCreateAt || 0) < bot.spacingSeconds) skip = "spacing";
        else if (balance < minBalanceWei(bot)) skip = "low_balance";
        else if (!bot.items.some((item) => (st.hints[hintKey(item)] || 0) < item.quantity)) skip = "no_items_left";
        if (skip) event("seller_skip", { bot: bot.id, reason: skip });
        else {
          const outcome = await create(bot, st, key, address, balance, result);
          if (outcome !== "created") event("seller_skip", { bot: bot.id, reason: outcome });
        }
      }
      st.errors = 0;
      st.lastError = null;
    } catch (error) {
      const code = classifyError(error);
      st.errors += 1;
      st.lastError = code;
      result.errors += 1;
      event("seller_error", { bot: bot.id, stage, code, consecutive: st.errors });
      if (st.errors >= cfg.maxErrors) await pause(bot, code);
    }
    await store.putProgress(progress);
  }
};

// ---- Lambda entry (real AWS clients, created lazily so tests never load the SDK) ----
let cached = null;
const sellerJob = async () => {
  if (!cached) {
    const { JsonRpcProvider } = require("ethers");
    const { createDynamoSellerStore } = require("./sellerStore");
    const { createSellerChain } = require("./sellerChain");
    const chainId = Number(process.env.CHAIN_ID || 23295);
    if (chainId !== 23295 && chainId !== 23293) throw new Error("CHAIN_ID must be a Sapphire testnet or localnet id");
    const provider = new JsonRpcProvider(process.env.RPC_URL, chainId, { staticNetwork: true, batchMaxCount: 1 });
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secrets = new SecretsManagerClient({});
    let secretPromise = null;
    const getSecret = () => {
      if (!secretPromise) {
        secretPromise = secrets.send(new GetSecretValueCommand({ SecretId: process.env.SELLER_SECRET_ID })).then((out) => JSON.parse(out.SecretString || "{}"));
        secretPromise.catch(() => { secretPromise = null; });
      }
      return secretPromise;
    };
    cached = {
      store: createDynamoSellerStore({ table: process.env.FAUCET_TABLE }), chain: createSellerChain({ provider, factoryAddress: process.env.FACTORY_ADDRESS, chainId }), getSecret,
      settings: process.env.SELLER_CREATE_GAS ? { createGas: BigInt(process.env.SELLER_CREATE_GAS) } : {},
    };
  }
  return runSellerJob(cached);
};

module.exports = { runSellerJob, sellerJob, classifyError, DEFAULTS };
