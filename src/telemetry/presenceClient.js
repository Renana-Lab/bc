const configuredApiUrl = String(
  process.env.REACT_APP_PRESENCE_API_URL ||
    (typeof window !== "undefined"
      ? window.__BC_PRESENCE_CONFIG__?.apiUrl || ""
      : ""),
)
  .trim()
  .replace(/\/$/, "");

const PRESENCE_SESSION_KEY = "bc:presence:session:v1";
const PRESENCE_HASH_NAMESPACE = String(
  process.env.REACT_APP_PRESENCE_HASH_NAMESPACE || "bc-live-presence-v1",
);
export const PRESENCE_UPDATE_EVENT = "bc:presence:update";
export const PRESENCE_ROLE_EVENT = "bc:presence:role";
export const PRESENCE_HEARTBEAT_MS = Math.max(
  10000,
  Number(process.env.REACT_APP_PRESENCE_HEARTBEAT_MS || 15000),
);

let currentAdminRole = false;

const makeSessionId = () => {
  const cryptoObject = typeof window !== "undefined" ? window.crypto : null;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID().replace(/-/g, "");
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}${random}${random}`.slice(0, 40);
};

const getSessionId = () => {
  if (typeof window === "undefined") return "server-render-session";
  try {
    const stored = window.sessionStorage.getItem(PRESENCE_SESSION_KEY);
    if (stored) return stored;
    const created = makeSessionId();
    window.sessionStorage.setItem(PRESENCE_SESSION_KEY, created);
    return created;
  } catch (_) {
    return makeSessionId();
  }
};

const bytesToHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const hashPresenceActor = async (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const payload = new TextEncoder().encode(`${PRESENCE_HASH_NAMESPACE}:${normalized}`);
  const digest = await window.crypto.subtle.digest("SHA-256", payload);
  return bytesToHex(new Uint8Array(digest));
};

const fetchPresence = async (path, options = {}) => {
  if (!configuredApiUrl) {
    throw Object.assign(new Error("Live activity is not configured for this deployment."), {
      code: "PRESENCE_NOT_CONFIGURED",
    });
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${configuredApiUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Live activity request failed (${response.status}).`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Live activity did not respond in time.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};

export const isPresenceConfigured = () => Boolean(configuredApiUrl);

export const setPresenceAdminRole = (isAdmin) => {
  currentAdminRole = Boolean(isAdmin);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PRESENCE_ROLE_EVENT, { detail: { isAdmin: currentAdminRole } }),
    );
  }
};

export const getPresenceAdminRole = () => currentAdminRole;

export const publishPresenceUpdate = (payload) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PRESENCE_UPDATE_EVENT, { detail: payload }));
};

export const sendPresenceHeartbeat = async ({
  account,
  isAdmin = currentAdminRole,
  route = "/",
  bots = [],
  activeAuctions = null,
}) => {
  const accountActorId = await hashPresenceActor(account);

  const botActors = await Promise.all(
    bots.slice(0, 49).map(async (bot) => ({
      type: "bot",
      actorId: await hashPresenceActor(bot.wallet || bot.id),
    })),
  );
  const entities = [
    ...(accountActorId
      ? [{ type: "session", role: isAdmin ? "admin" : "user", actorId: accountActorId }]
      : []),
    ...botActors.filter((bot) => bot.actorId),
  ];
  if (!entities.length) {
    throw new Error("A connected wallet or a running bot is required for presence.");
  }

  const payload = await fetchPresence("/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      sessionId: getSessionId(),
      route,
      entities,
      activeAuctions,
    }),
  });
  publishPresenceUpdate({ ...payload, status: "live" });
  return payload;
};

export const getLivePresence = async () => {
  const payload = await fetchPresence("/live");
  publishPresenceUpdate({ ...payload, status: "live" });
  return payload;
};

export const getPresenceHistory = async ({ from, to }) => {
  const query = new URLSearchParams({ from, to });
  const payload = await fetchPresence(`/history?${query.toString()}`);
  return Array.isArray(payload.rows) ? payload.rows : [];
};

export const toActivityReportRows = (rows = []) =>
  rows.map((row) => ({
    "Time ISO": row.timestampIso || new Date(row.timestamp).toISOString(),
    Time: new Date(row.timestampIso || row.timestamp).toLocaleString(),
    "Users Online": Number(row.users || 0),
    "Admins Online": Number(row.admins || 0),
    "Bots Online": Number(row.bots || 0),
    "Active Auctions": Number(row.activeAuctions || 0),
    "Browser Sessions": Number(row.sessions || 0),
    "Sample Interval": "1 minute",
  }));
