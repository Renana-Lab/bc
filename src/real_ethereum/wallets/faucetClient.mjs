// Browser client for the protected faucet (infrastructure/faucet). Turns every failure into a short,
// friendly message instead of a raw "Failed to fetch" or an error code. Nothing here logs the participant id.

export const NETWORK_MESSAGE = "Could not reach the test-funds service. Check your connection and try again.";

export const FAUCET_MESSAGES = {
  faucet_closed: "Test funds are not available right now.",
  budget_exhausted: "All test funds for this study have already been handed out. Tell the experimenter.",
  not_eligible: "This participant id cannot receive test funds (it was already used with another wallet, or it does not belong to this study).",
  faucet_empty: "The faucet is empty. Tell the experimenter.",
  transfer_failed: "The transfer failed. Use a normal wallet address.",
  rate_limited: "Too many requests. Wait a few minutes.",
  bad_request: "This link does not contain a valid participant id.",
};

export class FaucetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FaucetError";
    this.code = code;
  }
}

const baseUrl = (faucetUrl) => String(faucetUrl || "").replace(/\/+$/, "");
const readJson = async (response) => (await response.json().catch(() => null)) ?? {};
const friendly = (code) => FAUCET_MESSAGES[code] || "Faucet request refused.";

// GET /status -> { open: true|false|null, updatedAt, pidMode }. null means "unknown" (unreachable); never throws.
// pidMode ("allowlist" | "prolific" | "open" | null) tells the app whether non-hex ids may be sent.
export const fetchFaucetStatus = async ({ faucetUrl, fetchImpl = (...args) => fetch(...args) }) => {
  try {
    const response = await fetchImpl(`${baseUrl(faucetUrl)}/status`, { method: "GET" });
    const body = await readJson(response);
    if (!response.ok || typeof body.open !== "boolean") return { open: null, updatedAt: null, pidMode: null };
    const pidMode = ["allowlist", "prolific", "open"].includes(body.pidMode) ? body.pidMode : null;
    return { open: body.open, updatedAt: body.updatedAt ?? null, pidMode };
  } catch {
    return { open: null, updatedAt: null, pidMode: null };
  }
};

// POST /claim. Resolves with "paid" | "already_paid"; rejects with a FaucetError whose message is user-ready.
// 429 (Lambda throttling), 202 (payment still confirming), 409 (in progress) and 5xx are retried.
export const claimFunds = async ({
  faucetUrl, pid, address, studyId, experimentCode, onBusy = () => {}, fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  const payload = { pid, address, ...(studyId ? { studyId } : {}), ...(experimentCode ? { experimentCode } : {}) };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl(faucetUrl)}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch {
      throw new FaucetError("network", NETWORK_MESSAGE);
    }
    const body = await readJson(response);
    if (response.status === 200 && (body.status === "paid" || body.status === "already_paid")) return body.status;
    if ([400, 403, 422, 503].includes(response.status) || body.error === "rate_limited") {
      throw new FaucetError(body.error || "refused", friendly(body.error));
    }
    onBusy();
    await sleep(2000 * (attempt + 1));
  }
  throw new FaucetError("busy", "The faucet is busy. Try again in a minute.");
};

// POST /admin/state. The password is sent once and never kept by this module.
export const setFaucetState = async ({ faucetUrl, open, password, fetchImpl = (...args) => fetch(...args) }) => {
  let response;
  try {
    response = await fetchImpl(`${baseUrl(faucetUrl)}/admin/state`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open, password }),
    });
  } catch {
    throw new FaucetError("network", NETWORK_MESSAGE);
  }
  const body = await readJson(response);
  if (response.status === 200 && typeof body.open === "boolean") return { open: body.open, updatedAt: body.updatedAt ?? null };
  if (response.status === 401) throw new FaucetError("unauthorized", "Wrong password.");
  if (response.status === 429) throw new FaucetError("rate_limited", "Too many attempts. Wait ten minutes and try again.");
  throw new FaucetError("failed", "The change was not saved. Try again.");
};
