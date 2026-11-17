import { sha256, toUtf8Bytes } from "ethers";
import { adminAuthFailure, adminAuthHeaders, adminBodyAuth } from "./adminAuthHeaders.mjs";

// Browser client for the faucet's auto-return endpoints (/sweep/*). Every failure is silent: the participant is
// never told, and nothing here logs the participant id or a transaction.
const baseUrl = (faucetUrl) => String(faucetUrl || "").replace(/\/+$/, "");
const readJson = async (response) => (await response.json().catch(() => null)) ?? {};
const defaultFetch = (...args) => fetch(...args);

// The id the faucet stores is the SHA-256 of the id as it validated it: open ids as typed (trimmed), Prolific ids
// lower-cased, allowlist codes exactly. Mirrors infrastructure/faucet/handler.js.
export const pidHashFor = ({ strictPid, openPid, pidMode }) => {
  const text = pidMode === "open" ? String(openPid || strictPid || "").trim()
    : pidMode === "prolific" ? String(strictPid || "").toLowerCase()
      : String(strictPid || "");
  return text ? sha256(toUtf8Bytes(text)).slice(2) : "";
};

// GET /sweep/config -> { sweepAddress, chainId, pidMode } or null.
export const fetchSweepConfig = async ({ faucetUrl, fetchImpl = defaultFetch }) => {
  try {
    const response = await fetchImpl(`${baseUrl(faucetUrl)}/sweep/config`, { method: "GET" });
    const body = await readJson(response);
    return response.ok && typeof body.chainId === "number" ? body : null;
  } catch {
    return null;
  }
};

// POST /sweep/arm | /sweep/heartbeat -> { status: HTTP status, body }. Never throws; status 0 = unreachable.
export const postSweep = async ({ faucetUrl, path, payload, fetchImpl = defaultFetch }) => {
  try {
    const response = await fetchImpl(`${baseUrl(faucetUrl)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), keepalive: true });
    return { status: response.status, body: await readJson(response) };
  } catch {
    return { status: 0, body: {} };
  }
};

// Best-effort last update while the page is closing. A string body is sent as text/plain: a simple (non-preflighted) request.
export const beaconSweep = ({ faucetUrl, path, payload, nav = globalThis.navigator }) => {
  try {
    if (!nav?.sendBeacon) return false;
    return nav.sendBeacon(`${baseUrl(faucetUrl)}${path}`, JSON.stringify(payload));
  } catch {
    return false;
  }
};

// ---- admin (password in a header, never the URL) ----
export const fetchSweeps = async ({ faucetUrl, password, proof, fetchImpl = defaultFetch }) => {
  const response = await fetchImpl(`${baseUrl(faucetUrl)}/admin/sweeps`, { method: "GET", headers: adminAuthHeaders({ proof, password }) });
  const body = await readJson(response);
  if (response.status === 200 && Array.isArray(body.sweeps)) return body;
  const denied = adminAuthFailure(response, { proof });
  throw Object.assign(new Error(denied ? denied.message : "The auto-return list could not be read."), { code: denied ? denied.code : "failed" });
};

export const saveSweepIdleMinutes = async ({ faucetUrl, password, proof, idleMinutes, fetchImpl = defaultFetch }) => {
  const response = await fetchImpl(`${baseUrl(faucetUrl)}/admin/sweep-settings`, {
    method: "POST", headers: { "content-type": "application/json", ...(proof ? adminAuthHeaders({ proof }) : {}) }, body: JSON.stringify({ idleMinutes, ...adminBodyAuth({ proof, password }) }),
  });
  const body = await readJson(response);
  if (response.status === 200 && Number.isInteger(body.idleMinutes)) return body.idleMinutes;
  const denied = adminAuthFailure(response, { proof });
  throw Object.assign(new Error(denied ? denied.message : "Use a whole number of minutes from 15 to 1440."), { code: denied ? denied.code : "failed" });
};
