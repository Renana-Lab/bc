const DEFAULT_RPC_URLS = [
  "https://sepolia.gateway.tenderly.co",
  "https://sepolia.rpc.thirdweb.com",
  "https://ethereum-sepolia-rpc.publicnode.com",
];

const endpointHealth = new Map();
const endpointLanes = new Map();
const NETWORK_COOLDOWN_MS = 30 * 1000;
const CAPACITY_COOLDOWN_MS = 2 * 60 * 1000;
const UNSUPPORTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const RPC_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.REACT_APP_RPC_MAX_CONCURRENCY || 1)),
);
const RPC_MIN_INTERVAL_MS = Math.max(
  50,
  Number(process.env.REACT_APP_RPC_MIN_INTERVAL_MS || 180),
);
const RPC_HEALTH_STORAGE_KEY = "data-market:rpc-health:v1";

const normalizeRpcUrl = (url) => String(url || "").trim();

const loadPersistedHealth = () => {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(RPC_HEALTH_STORAGE_KEY) || "{}");
    Object.entries(stored).forEach(([url, health]) => {
      if (health && Number(health.cooldownUntil || 0) > Date.now()) {
        endpointHealth.set(url, health);
      }
    });
  } catch (_) {}
};

const persistHealth = () => {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const active = {};
    endpointHealth.forEach((health, url) => {
      if (Number(health.cooldownUntil || 0) > Date.now()) active[url] = health;
    });
    window.localStorage.setItem(RPC_HEALTH_STORAGE_KEY, JSON.stringify(active));
  } catch (_) {}
};

loadPersistedHealth();
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (event) => {
    if (event.key !== RPC_HEALTH_STORAGE_KEY) return;
    endpointHealth.clear();
    loadPersistedHealth();
  });
}

const getCooldownBase = (kind) => {
  if (kind === "unsupported-plan") return UNSUPPORTED_COOLDOWN_MS;
  if (kind === "capacity") return CAPACITY_COOLDOWN_MS;
  return NETWORK_COOLDOWN_MS;
};

const splitRpcUrls = (value) =>
  String(value || "")
    .split(",")
    .map(normalizeRpcUrl)
    .filter(Boolean);

export const getConfiguredRpcUrls = () => {
  const infuraKey = String(process.env.REACT_APP_INFURA_KEY || "").trim();
  const alchemyKey = String(process.env.REACT_APP_ALCHEMY_API_KEY || "").trim();
  const configured = [
    ...splitRpcUrls(process.env.REACT_APP_RPC_URLS),
    normalizeRpcUrl(process.env.REACT_APP_RPC_URL),
    infuraKey ? `https://sepolia.infura.io/v3/${infuraKey}` : "",
    alchemyKey ? `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}` : "",
    ...DEFAULT_RPC_URLS,
  ].filter(Boolean);

  return [...new Set(configured)];
};

export const getRpcErrorMessage = (error) =>
  String(
    error?.message ||
      error?.data?.message ||
      error?.error?.message ||
      error ||
      "",
  );

export const getRpcFailureKind = (error) => {
  if (error?.code === "RPC_POOL_UNAVAILABLE") return "network";
  if (error?.code === "RPC_ENDPOINT_COOLDOWN") {
    return error.failureKind || "capacity";
  }
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  if (status === 401 || status === 403) return "unsupported-plan";
  if (status === 429) return "capacity";
  if (status >= 500 && status <= 599) return "network";
  const message = getRpcErrorMessage(error).toLowerCase();

  if (
    message.includes("chain is not available") ||
    message.includes("free plan") ||
    message.includes("upgrade to paid") ||
    message.includes("unsupported chain") ||
    message.includes("unauthorized") ||
    message.includes("invalid api key") ||
    message.includes("forbidden")
  ) {
    return "unsupported-plan";
  }

  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("usage limit") ||
    message.includes("capacity reached") ||
    message.includes("quota exceeded") ||
    message.includes("current plan") ||
    message.includes("higher limits") ||
    message.includes("429")
  ) {
    return "capacity";
  }

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("failed to fetch") ||
    message.includes("network error") ||
    message.includes("connection error") ||
    message.includes("connection not open") ||
    message.includes("couldn't connect") ||
    message.includes("could not connect") ||
    message.includes("connection refused") ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout") ||
    message.includes("status code 404") ||
    message.includes("status code 500") ||
    message.includes("status code 502") ||
    message.includes("status code 503") ||
    message.includes("status code 504") ||
    message.includes("econnrefused") ||
    message.includes("enotfound")
  ) {
    return "network";
  }

  return "other";
};
export const isRpcProviderFailure = (error) =>
  getRpcFailureKind(error) !== "other";

export const markRpcProviderSuccess = (url, latencyMs = 0) => {
  const key = normalizeRpcUrl(url);
  if (!key) return;
  const previous = endpointHealth.get(key) || {};
  const previousLatency = Number(previous.latencyMs || 0);
  if (Number(previous.cooldownUntil || 0) > Date.now()) return;
  const clearedPersistedCooldown = Number(previous.cooldownUntil || 0) > 0;
  endpointHealth.set(key, {
    failures: Math.max(0, Number(previous.failures || 0) - 1),
    cooldownUntil: 0,
    succeededAt: Date.now(),
    latencyMs: previousLatency
      ? Math.round(previousLatency * 0.7 + Number(latencyMs || previousLatency) * 0.3)
      : Number(latencyMs || 0),
  });
  if (clearedPersistedCooldown) persistHealth();
};

const getRetryAfterMs = (error) => {
  const raw =
    error?.response?.headers?.get?.("retry-after") ||
    error?.response?.headers?.["retry-after"] ||
    error?.headers?.["retry-after"] ||
    error?.retryAfter;
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
};

export const markRpcProviderFailure = (url, error, now = Date.now()) => {
  const key = normalizeRpcUrl(url);
  if (!key) return null;
  if (error?.code === "RPC_ENDPOINT_COOLDOWN") {
    return endpointHealth.get(key) || null;
  }

  const kind = getRpcFailureKind(error);
  const previous = endpointHealth.get(key) || {};
  const failures = Number(previous.failures || 0) + 1;
  const cooldownMs =
    kind === "unsupported-plan"
      ? UNSUPPORTED_COOLDOWN_MS
      : Math.min(
          MAX_COOLDOWN_MS,
          Math.max(
            getRetryAfterMs(error),
            getCooldownBase(kind) * 2 ** Math.min(4, failures - 1),
          ),
        );
  const health = {
    kind,
    failures,
    failedAt: now,
    cooldownUntil: now + cooldownMs,
  };
  endpointHealth.set(key, health);
  const lane = endpointLanes.get(key);
  if (lane?.queue?.length) {
    const queued = lane.queue.splice(0);
    queued.forEach((item) => {
      const cooldownError = new Error("RPC endpoint is cooling down.");
      cooldownError.code = "RPC_ENDPOINT_COOLDOWN";
      cooldownError.failureKind = kind;
      item.reject(cooldownError);
    });
  }
  persistHealth();
  return health;
};

export const getHealthyRpcUrls = (urls = getConfiguredRpcUrls(), now = Date.now()) =>
  [...new Set((urls || []).map(normalizeRpcUrl).filter(Boolean))].filter(
    (url) => Number(endpointHealth.get(url)?.cooldownUntil || 0) <= now,
  );

const getLane = (url) => {
  const key = normalizeRpcUrl(url);
  if (!endpointLanes.has(key)) {
    endpointLanes.set(key, {
      active: 0,
      queue: [],
      lastStartedAt: 0,
      timer: null,
    });
  }
  return endpointLanes.get(key);
};

const drainLane = (url) => {
  const lane = getLane(url);
  if (lane.active >= RPC_MAX_CONCURRENCY || !lane.queue.length) return;

  const delay = Math.max(
    0,
    RPC_MIN_INTERVAL_MS - (Date.now() - Number(lane.lastStartedAt || 0)),
  );
  if (delay > 0) {
    if (!lane.timer) {
      lane.timer = setTimeout(() => {
        lane.timer = null;
        drainLane(url);
      }, delay);
    }
    return;
  }

  const item = lane.queue.shift();
  lane.active += 1;
  lane.lastStartedAt = Date.now();
  Promise.resolve()
    .then(item.operation)
    .then(item.resolve, item.reject)
    .finally(() => {
      lane.active -= 1;
      drainLane(url);
    });

  drainLane(url);
};

export const scheduleRpcRequest = (url, operation) =>
  new Promise((resolve, reject) => {
    const key = normalizeRpcUrl(url);
    if (!key) {
      reject(new Error("A valid RPC endpoint is required."));
      return;
    }
    const health = endpointHealth.get(key);
    if (Number(health?.cooldownUntil || 0) > Date.now()) {
      const cooldownError = new Error("RPC endpoint is cooling down.");
      cooldownError.code = "RPC_ENDPOINT_COOLDOWN";
      cooldownError.failureKind = health.kind || "capacity";
      reject(cooldownError);
      return;
    }
    const lane = getLane(key);
    lane.queue.push({ operation, resolve, reject });
    drainLane(key);
  });

export const getRpcPoolSnapshot = (urls = getConfiguredRpcUrls()) =>
  [...new Set((urls || []).map(normalizeRpcUrl).filter(Boolean))].map((url) => {
    const health = endpointHealth.get(url) || {};
    const lane = getLane(url);
    return {
      url,
      failures: Number(health.failures || 0),
      cooldownUntil: Number(health.cooldownUntil || 0),
      latencyMs: Number(health.latencyMs || 0),
      active: lane.active,
      queued: lane.queue.length,
    };
  });

export const getRpcRetryDelay = (urls = getConfiguredRpcUrls(), now = Date.now()) => {
  const cooldowns = [...new Set((urls || []).map(normalizeRpcUrl).filter(Boolean))]
    .map((url) => Number(endpointHealth.get(url)?.cooldownUntil || 0))
    .filter((until) => until > now);
  return cooldowns.length ? Math.max(0, Math.min(...cooldowns) - now) : 0;
};

export const createRpcPoolError = (failures = [], urls = getConfiguredRpcUrls()) => {
  const error = new Error(
    "Blockchain connectivity is temporarily unavailable after trying every configured connection.",
  );
  error.code = "RPC_POOL_UNAVAILABLE";
  error.providerFailures = failures.map(({ url, error: failure }) => ({
    url: normalizeRpcUrl(url),
    kind: getRpcFailureKind(failure),
  }));
  error.retryAfterMs = getRpcRetryDelay(urls);
  return error;
};

export const executeWithRpcFailover = async (
  urls,
  operation,
  { startIndex = 0, onProviderFailure } = {},
) => {
  const configured = [...new Set((urls || []).map(normalizeRpcUrl).filter(Boolean))];
  const healthy = getHealthyRpcUrls(configured);
  if (!healthy.length) throw createRpcPoolError([], configured);

  const offset = ((Number(startIndex) || 0) % healthy.length + healthy.length) % healthy.length;
  const ordered = [...healthy.slice(offset), ...healthy.slice(0, offset)];
  const failures = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const url = ordered[index];
    const startedAt = Date.now();
    try {
      const value = await scheduleRpcRequest(url, () => operation(url, index));
      markRpcProviderSuccess(url, Date.now() - startedAt);
      return { value, url, attempts: index + 1 };
    } catch (error) {
      if (!isRpcProviderFailure(error)) throw error;
      const health = markRpcProviderFailure(url, error);
      failures.push({ url, error });
      onProviderFailure?.({ url, error, health, attempt: index + 1 });
    }
  }

  throw createRpcPoolError(failures, configured);
};

export const resetRpcProviderHealth = () => {
  endpointHealth.clear();
  persistHealth();
};
export const __resetRpcProviderHealthForTests = resetRpcProviderHealth;

export const getFriendlyRpcError = (error) => {
  if (error?.code === "RPC_POOL_UNAVAILABLE") {
    return "Blockchain data is reconnecting automatically. Existing data remains available while the connection pool recovers.";
  }
  const kind = getRpcFailureKind(error);

  if (kind === "unsupported-plan") {
    return "An RPC endpoint does not support Sepolia on its current plan and has been disabled for this session.";
  }

  if (kind === "capacity") {
    return "Blockchain data is syncing through a backup connection.";
  }

  if (kind === "network") {
    return "Blockchain connectivity was interrupted. Automatic connection recovery is in progress.";
  }

  return getRpcErrorMessage(error) || "Unknown blockchain connection error.";
};
