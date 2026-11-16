"use strict";
// Admin-to-participant messages ("inbox"). Pure helpers shared by the handler; storage lives in store.js / memoryStore.js.
//
//   inbox#<pidHash>     { messages: [{ id, body, createdAt, readAt? }], acked: [broadcast ids], v, expiresAt }
//   config#broadcast    { messages: [{ id, body, createdAt }], v, expiresAt }          (send to everybody)
//
// Both live in the codes table (they hold a pid hash at most, never an IP) and expire by DynamoDB TTL.
// Lists are capped; every write is a conditional write on `v` (optimistic concurrency), retried a few times.
const MAX_BODY_CHARS = 1000;
const MAX_DIRECT_MESSAGES = 50; // per participant: the oldest drop out first
const MAX_BROADCASTS = 20;
const MAX_ACKED = 40;
const TTL_SECONDS = 14 * 24 * 3600;
const MAX_ACK_IDS = 20;
const MAX_WRITE_ATTEMPTS = 12;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Trimmed text, control characters other than newline and tab removed. Returns "" when nothing usable is left.
const cleanBody = (value) => {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000d-\u001f\u007f]/g, "").trim();
};

const publicDirect = (message) => ({ id: message.id, body: message.body, createdAt: message.createdAt, readAt: message.readAt ?? null });
const publicUnread = (message) => ({ id: message.id, body: message.body, createdAt: message.createdAt });

// What a participant still has to read: unread direct messages plus broadcasts it has not acknowledged,
// oldest first. Broadcasts sent before the participant was paid (`since`, ms) are not shown: they are not about this session.
// All times are milliseconds.
const unreadFor = ({ inbox, broadcast, since = 0, nowMs }) => {
  const live = (message) => message.createdAt > nowMs - TTL_SECONDS * 1000;
  const acked = new Set(inbox?.acked || []);
  const direct = (inbox?.messages || []).filter((message) => !message.readAt && live(message));
  const shared = (broadcast?.messages || []).filter((message) => !acked.has(message.id) && message.createdAt >= since && live(message));
  return [...direct, ...shared].sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id))).map(publicUnread);
};

module.exports = {
  MAX_BODY_CHARS, MAX_DIRECT_MESSAGES, MAX_BROADCASTS, MAX_ACKED, TTL_SECONDS, MAX_ACK_IDS, MAX_WRITE_ATTEMPTS, ID_PATTERN,
  cleanBody, publicDirect, publicUnread, unreadFor,
};
