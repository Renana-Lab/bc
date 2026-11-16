/* global BigInt */
// Data layer of the admin "Participants gas" card: who to list, who is low, and the sequential top-up run.
// Pure functions + injectable readers/senders so everything is unit-testable without a chain.
import { ADMIN_GAS_RESERVE_WEI, parseNative } from "../../real_ethereum/wallets/nativeBalance";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lower = (value) => String(value ?? "").trim().toLowerCase();
export const isAddressLike = (value) => ADDRESS.test(String(value ?? "").trim());

export const DEFAULT_THRESHOLD = "0.1";
export const DEFAULT_TOPUP_AMOUNT = "0.5";
export const REFRESH_MS = 60_000;
const KEYS = { threshold: "bc:participants-gas:threshold", amount: "bc:participants-gas:amount", manual: "bc:participants-gas:manual" };

export const loadSetting = (name, fallback, storage = globalThis.localStorage) => {
  try { return storage?.getItem(KEYS[name]) || fallback; } catch { return fallback; }
};
export const saveSetting = (name, value, storage = globalThis.localStorage) => {
  try { storage?.setItem(KEYS[name], value); } catch { /* optional */ }
};
export const loadManualAddresses = (storage) => {
  try {
    const parsed = JSON.parse(loadSetting("manual", "[]", storage));
    return Array.isArray(parsed) ? Array.from(new Set(parsed.map(lower).filter(isAddressLike))) : [];
  } catch { return []; }
};
export const saveManualAddresses = (list, storage) => saveSetting("manual", JSON.stringify(list), storage);

// Addresses that appear in existing on-chain data: event actors (bidders via BudgetChanged, sellers who created auctions).
export const addressesFromEvents = (events = []) => {
  const found = new Map(); // address -> latest block seen
  events.forEach((event) => {
    const candidates = [event.actor, event.args?.user, event.args?.seller, event.args?.contributor];
    candidates.map(lower).filter(isAddressLike).forEach((address) => {
      const block = Number(event.blockNumber) || 0;
      if (!found.has(address) || block > found.get(address)) found.set(address, block);
    });
  });
  return found;
};

// Merge every source into one de-duplicated, lower-case keyed list. `pidByAddress` stays empty unless the faucet admin
// API ever exposes a participant list (today it only stores hashes), so the pid column is blank.
export const buildParticipantRows = ({
  users = [], events = [], manual = [], bots = new Set(), labels = {}, pidByAddress = {},
  balances = {}, budgets = {}, latestBlock = null, thresholdWei = null,
}) => {
  const activity = addressesFromEvents(events);
  const rows = new Map();
  const add = (raw, source) => {
    const address = lower(raw);
    if (!isAddressLike(address)) return;
    if (!rows.has(address)) rows.set(address, { address, sources: new Set() });
    rows.get(address).sources.add(source);
  };
  users.forEach((address) => add(address, "factory"));
  activity.forEach((_block, address) => add(address, "activity"));
  manual.forEach((address) => add(address, "manual"));
  Array.from(bots).forEach((address) => add(address, "bot"));
  return Array.from(rows.values())
    .map(({ address, sources }) => {
      const balanceWei = balances[address] === undefined || balances[address] === null ? null : BigInt(balances[address]);
      const lastBlock = activity.has(address) ? activity.get(address) : null;
      return {
        address,
        pid: pidByAddress[address] || "",
        label: labels[address] || "",
        sources: Array.from(sources),
        isBot: sources.has("bot"),
        balanceWei,
        budget: budgets[address] ?? "",
        lastBlock,
        blocksAgo: lastBlock !== null && latestBlock !== null ? Math.max(0, Number(latestBlock) - lastBlock) : null,
        low: thresholdWei !== null && balanceWei !== null && balanceWei < thresholdWei,
      };
    })
    // Lowest balance first so the rows that need attention are on top; unknown balances last.
    .sort((a, b) => {
      if (a.balanceWei === null && b.balanceWei === null) return a.address.localeCompare(b.address);
      if (a.balanceWei === null) return 1;
      if (b.balanceWei === null) return -1;
      return a.balanceWei < b.balanceWei ? -1 : a.balanceWei > b.balanceWei ? 1 : a.address.localeCompare(b.address);
    });
};

export const selectLowRows = (rows) => rows.filter((row) => row.low);

export const planTopUp = ({ rows, amountText }) => {
  const amountWei = parseNative(amountText);
  const count = rows.length;
  return { amountWei, count, totalWei: amountWei ? amountWei * BigInt(count) : 0n };
};

// Sends one transaction per address, strictly in order. Before every send the admin balance is re-read; when it cannot
// cover amount + gas reserve the run STOPS and the remaining rows are marked "skipped". A rejected signature stops the
// run too. `send(address, amountWei)` resolves with a hash; `waitFor(hash)` with true/false (mined ok).
export const runTopUps = async ({
  targets, amountWei, send, waitFor, getAdminBalance, onStatus = () => {}, reserveWei = ADMIN_GAS_RESERVE_WEI,
}) => {
  const results = [];
  const mark = (address, status) => { results.push({ address, ...status }); onStatus(address, status); };
  for (let index = 0; index < targets.length; index += 1) {
    const address = targets[index];
    let stopReason = "";
    try {
      const balance = BigInt(await getAdminBalance());
      if (balance < amountWei + reserveWei) stopReason = "Admin balance too low";
    } catch {
      stopReason = "Admin balance unavailable";
    }
    if (stopReason) {
      targets.slice(index).forEach((rest) => mark(rest, { state: "skipped", error: stopReason }));
      break;
    }
    onStatus(address, { state: "sending" });
    try {
      const hash = await send(address, amountWei);
      onStatus(address, { state: "sent", hash });
      const ok = await waitFor(hash);
      mark(address, ok ? { state: "confirmed", hash } : { state: "failed", hash, error: "Transaction failed" });
    } catch (error) {
      mark(address, { state: "failed", error: error?.message || "Transaction failed" });
      if (error?.code === 4001) { // the admin rejected the signature: do not keep prompting
        targets.slice(index + 1).forEach((rest) => mark(rest, { state: "skipped", error: "Cancelled" }));
        break;
      }
    }
  }
  return results;
};
