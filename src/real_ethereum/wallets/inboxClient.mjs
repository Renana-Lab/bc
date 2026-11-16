import { sweepMessage } from "./autoSweep.mjs";

// Browser client for the faucet's message endpoints (admin -> participant). Participant calls are signed with the
// wallet (EIP-191, same scheme as the auto-return heartbeat, actions "inbox" and "ack") and never throw: a failure is
// silent and simply tried again later. Admin calls send the password in a header (never the URL) and keep nothing.
const baseUrl = (faucetUrl) => String(faucetUrl || "").replace(/\/+$/, "");
const readJson = async (response) => (await response.json().catch(() => null)) ?? {};
const defaultFetch = (...args) => fetch(...args);

export const MAX_MESSAGE_CHARS = 1000;

// GET /inbox -> { ok, messages: [{ id, body, createdAt }], serverTime }. The signature travels in the query string
// (good for 5 minutes), so the request stays a simple cross-origin GET.
export const fetchInbox = async ({ faucetUrl, address, pidHash, signMessage, now = () => Date.now(), fetchImpl = defaultFetch }) => {
  try {
    const ts = now();
    const sig = await signMessage(sweepMessage("inbox", address, pidHash, ts));
    const query = new URLSearchParams({ pidHash, address, ts: String(ts), sig });
    const response = await fetchImpl(`${baseUrl(faucetUrl)}/inbox?${query}`, { method: "GET" });
    const body = await readJson(response);
    if (!response.ok || !Array.isArray(body.messages)) return { ok: false, messages: [], serverTime: null };
    const messages = body.messages
      .filter((message) => message && typeof message.id === "string" && typeof message.body === "string")
      .map((message) => ({ id: message.id, body: message.body, createdAt: message.createdAt ?? null }));
    return { ok: true, messages, serverTime: Number.isFinite(body.serverTime) ? body.serverTime : null };
  } catch {
    return { ok: false, messages: [], serverTime: null };
  }
};

// POST /inbox/ack. Resolves true once the server has recorded it.
export const ackInbox = async ({ faucetUrl, address, pidHash, ids, signMessage, now = () => Date.now(), fetchImpl = defaultFetch }) => {
  try {
    const ts = now();
    const sig = await signMessage(sweepMessage("ack", address, pidHash, ts));
    const response = await fetchImpl(`${baseUrl(faucetUrl)}/inbox/ack`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pidHash, address, ids, ts, sig }), keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
};

// ---- admin ----
const adminError = (response, fallback) => Object.assign(new Error(
  response.status === 401 ? "Wrong password." : response.status === 429 ? "Too many attempts. Wait ten minutes and try again."
    : response.status === 404 ? "This participant is not known to the faucet yet." : fallback,
), { code: response.status === 401 ? "unauthorized" : "failed" });

// POST /admin/messages { pidHash | all: true, body }
export const sendAdminMessage = async ({ faucetUrl, password, pidHash, all = false, body, fetchImpl = defaultFetch }) => {
  const response = await fetchImpl(`${baseUrl(faucetUrl)}/admin/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-admin-password": password }, body: JSON.stringify(all ? { all: true, body } : { pidHash, body }),
  });
  const result = await readJson(response);
  if (response.status === 200 && result.id) return result;
  throw adminError(response, "The message was not sent. Try again.");
};

// GET /admin/messages[?pidHash] -> { broadcasts: [{ id, body, createdAt, readCount | read }], participants: [{ pidHash, messages: [{ id, body, createdAt, readAt }] }] }
export const fetchAdminMessages = async ({ faucetUrl, password, pidHash, fetchImpl = defaultFetch }) => {
  const query = pidHash ? `?${new URLSearchParams({ pidHash })}` : "";
  const response = await fetchImpl(`${baseUrl(faucetUrl)}/admin/messages${query}`, { method: "GET", headers: { "x-admin-password": password } });
  const result = await readJson(response);
  if (response.status === 200 && Array.isArray(result.broadcasts) && Array.isArray(result.participants)) return result;
  throw adminError(response, "The message history could not be read.");
};
