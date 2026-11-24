"use strict";
// Seller-bot configuration: defaults, validation and the public (payload-free) view. Pure, no AWS and no chain access.
// The config item (config#sellerbots) is owned by the admin routes; the job only ever flips running/enabled to false.
const { parseEther } = require("ethers");

const LIMITS = {
  descriptionBytes: 1200, payloadBytes: 2000, minimumBid: 1_000_000_000, durationMinutes: 30, quantity: 50,
  minSpacingSeconds: 30, maxConcurrentOpen: 5, maxBots: 10, maxItemsPerBot: 20,
};
const BOT_ID = /^bot-[0-9]{1,2}$/;
const PRESENCE_MODES = ["sweep", "always"];
const FUND_DAY_KEY = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

const defaultConfig = () => ({
  enabled: false, presenceMode: "sweep", minActiveParticipants: 1, activeWindowMinutes: 5, idleGraceMinutes: 5,
  allowBuyerBotsOnSellerAuctions: false, nextSlot: 1, bots: [],
});

const bytes = (text) => Buffer.byteLength(String(text ?? ""), "utf8");
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const fail = (message) => Object.assign(new Error(message), { code: "INVALID" });

// minNativeBalance is a decimal number of TEST (not wei).
const minBalanceWei = (bot) => {
  try { return parseEther(String(bot.minNativeBalance ?? 0)); } catch { return 0n; }
};

// Validates the admin's full config against the stored one. Returns the config to store.
// Payloads are write-only: an empty/missing payload on an existing slot keeps the stored one.
const validateConfig = (input, stored, { knownBotIds = null } = {}) => {
  if (!input || typeof input !== "object") throw fail("config");
  const base = stored || defaultConfig();
  const out = {
    enabled: input.enabled === true,
    presenceMode: input.presenceMode ?? base.presenceMode,
    minActiveParticipants: input.minActiveParticipants ?? base.minActiveParticipants,
    activeWindowMinutes: input.activeWindowMinutes ?? base.activeWindowMinutes,
    idleGraceMinutes: input.idleGraceMinutes ?? base.idleGraceMinutes,
    allowBuyerBotsOnSellerAuctions: input.allowBuyerBotsOnSellerAuctions === true,
    nextSlot: base.nextSlot || 1,
    bots: [],
  };
  if (!PRESENCE_MODES.includes(out.presenceMode)) throw fail("presenceMode");
  if (!isInt(out.minActiveParticipants, 1, 1000)) throw fail("minActiveParticipants");
  if (!isInt(out.activeWindowMinutes, 1, 60)) throw fail("activeWindowMinutes");
  if (!isInt(out.idleGraceMinutes, 0, 120)) throw fail("idleGraceMinutes");
  if (!Array.isArray(input.bots) || input.bots.length > LIMITS.maxBots) throw fail("bots");
  const storedBots = new Map((base.bots || []).map((bot) => [bot.id, bot]));
  const seen = new Set();
  for (const bot of input.bots) {
    if (!bot || typeof bot.id !== "string" || !BOT_ID.test(bot.id) || seen.has(bot.id)) throw fail("bot id");
    if (knownBotIds && !knownBotIds.includes(bot.id)) throw fail("unknown bot");
    seen.add(bot.id);
    const before = storedBots.get(bot.id);
    const running = bot.running === true;
    const next = {
      id: bot.id, running,
      maxConcurrentOpen: bot.maxConcurrentOpen ?? 1,
      spacingSeconds: bot.spacingSeconds ?? 60,
      minNativeBalance: bot.minNativeBalance ?? 0.1,
      items: [],
    };
    if (!isInt(next.maxConcurrentOpen, 1, LIMITS.maxConcurrentOpen)) throw fail("maxConcurrentOpen");
    if (!isInt(next.spacingSeconds, LIMITS.minSpacingSeconds, 86400)) throw fail("spacingSeconds");
    if (typeof next.minNativeBalance !== "number" || !Number.isFinite(next.minNativeBalance) || next.minNativeBalance < 0 || next.minNativeBalance > 1000) throw fail("minNativeBalance");
    // A paused bot stays paused (with its error) until the admin switches it on again.
    if (!running && before?.lastError) next.lastError = before.lastError;
    if (!Array.isArray(bot.items) || bot.items.length > LIMITS.maxItemsPerBot) throw fail("items");
    const storedItems = new Map((before?.items || []).map((item) => [item.slot, item]));
    const usedSlots = new Set();
    for (const item of bot.items) {
      if (!item || typeof item !== "object") throw fail("item");
      const old = Number.isInteger(item.slot) ? storedItems.get(item.slot) : undefined;
      if (Number.isInteger(item.slot) && !old) throw fail("unknown slot");
      if (old && usedSlots.has(old.slot)) throw fail("duplicate slot");
      const description = typeof item.description === "string" ? item.description : "";
      const payloadText = typeof item.payload === "string" && item.payload !== "" ? item.payload : old?.payload;
      if (!description.trim() || bytes(description) > LIMITS.descriptionBytes) throw fail("description");
      if (typeof payloadText !== "string" || !payloadText.length || bytes(payloadText) > LIMITS.payloadBytes) throw fail("payload");
      if (!isInt(item.minimumBid, 1, LIMITS.minimumBid)) throw fail("minimumBid");
      if (!isInt(item.durationMinutes, 1, LIMITS.durationMinutes)) throw fail("durationMinutes");
      if (!isInt(item.quantity, 1, LIMITS.quantity)) throw fail("quantity");
      let slot = old?.slot;
      let seqBase = old?.seqBase || 0;
      if (!old) { slot = out.nextSlot; out.nextSlot += 1; }
      // Reset progress: every sequence number up to seqBase + quantity may be in use, so start after them.
      else if (item.resetProgress === true) seqBase = old.seqBase + old.quantity;
      usedSlots.add(slot);
      next.items.push({ slot, description, payload: payloadText, minimumBid: item.minimumBid, durationMinutes: item.durationMinutes, quantity: item.quantity, seqBase });
    }
    out.bots.push(next);
  }
  return out;
};

// What the admin API returns: payloads become byte lengths. Descriptions are public on chain anyway.
const publicConfig = (config) => ({
  ...config,
  bots: (config.bots || []).map((bot) => ({
    ...bot,
    items: bot.items.map(({ payload, ...item }) => ({ ...item, payloadBytes: bytes(payload) })),
  })),
});

module.exports = { LIMITS, BOT_ID, PRESENCE_MODES, defaultConfig, validateConfig, publicConfig, minBalanceWei, bytes, FUND_DAY_KEY };
