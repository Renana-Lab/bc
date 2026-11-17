// Helpers for the "Users and budgets" card: which addresses to list and who is online.
import { addressesFromEvents, isAddressLike } from "./participantsGasData";

export const ONLINE_WINDOW_MS = 5 * 60_000;

// Union of the three sources, de-duplicated case-insensitively, first spelling kept, in the order a) allUsers,
// b) bidders/sellers from the shared audit events, c) faucet sweep addresses. `registered` is the lowercase allUsers set.
export const unionParticipants = ({ users = [], events = [], sweepAddresses = [] }) => {
  const seen = new Set();
  const addresses = [];
  const add = (raw) => {
    const address = String(raw ?? "").trim();
    const key = address.toLowerCase();
    if (!isAddressLike(address) || seen.has(key)) return;
    seen.add(key);
    addresses.push(address);
  };
  users.forEach(add);
  Array.from(addressesFromEvents(events).keys()).forEach(add);
  sweepAddresses.forEach(add);
  return { addresses, registered: new Set(users.map((address) => String(address).toLowerCase())) };
};

export const lastSeenMs = (sweep) => {
  const ms = Date.parse(sweep?.lastSeen || "");
  return Number.isFinite(ms) ? ms : null;
};

export const isOnline = (sweep, now = Date.now()) => {
  const ms = lastSeenMs(sweep);
  return ms !== null && now - ms <= ONLINE_WINDOW_MS;
};

export const formatAgo = (ms, now = Date.now()) => {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

// Wallets that appear in the audit snapshot as args.by / args.admin (admins acting on the factory).
export const adminAddressesFromEvents = (events = []) => {
  const found = new Set();
  events.forEach((event) => {
    [event.args?.by, event.args?.admin].map((value) => String(value ?? "").trim().toLowerCase()).filter(isAddressLike).forEach((address) => found.add(address));
  });
  return found;
};

// Admin chip + "admin only": an admin wallet whose only reason to be listed is not a seller / bidder / user / allUsers entry.
export const classifyAdmin = ({ address, admins, roles }) => {
  const key = String(address).toLowerCase();
  const isAdmin = admins.has(key);
  return { isAdmin, adminOnly: isAdmin && !roles.has(key) };
};
