import { adminAuthFailure, adminAuthHeaders } from "./adminAuthHeaders.mjs";

// Browser client for the faucet's seller-bot admin routes (/admin/seller-bots*). Credentials always go in headers
// (wallet proof, or the password as the break-glass fallback), never in a URL. Payloads are write-only: the server returns
// byte lengths. 404 means the seller part of the stack is not deployed yet.
const baseUrl = (faucetUrl) => String(faucetUrl || "").replace(/\/+$/, "");
const readJson = async (response) => (await response.json().catch(() => null)) ?? {};
const defaultFetch = (...args) => fetch(...args);
const fail = (code, message) => Object.assign(new Error(message), { code });

const request = async ({ faucetUrl, path, method, password, proof, payload, fetchImpl = defaultFetch }) => {
  const response = await fetchImpl(`${baseUrl(faucetUrl)}${path}`, {
    method,
    headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...adminAuthHeaders({ proof, password }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = await readJson(response);
  if (response.status === 200) return body;
  if (response.status === 404) throw fail("not_deployed", "Seller bots are not deployed yet.");
  if (response.status === 409) throw Object.assign(fail("version_conflict", "The configuration changed elsewhere. Reload and apply your edit again."), { version: body.version });
  if (response.status === 400) throw fail("invalid", `The server rejected the settings${body.field ? ` (${body.field})` : ""}.`);
  if (response.status === 413) throw fail("too_large", "The configuration is too large.");
  const denied = adminAuthFailure(response, { proof });
  if (denied) throw fail(denied.code, denied.message);
  throw fail("failed", "The seller bot request failed.");
};

export const fetchSellerBots = (options) => request({ ...options, path: "/admin/seller-bots", method: "GET" });
export const saveSellerBots = ({ config, version, ...options }) => request({ ...options, path: "/admin/seller-bots", method: "POST", payload: { ...config, version } });
export const stopAllSellerBots = (options) => request({ ...options, path: "/admin/seller-bots/stop-all", method: "POST", payload: {} });
export const fundSellerBot = ({ botId, amountWei, ...options }) => request({ ...options, path: "/admin/seller-bots/fund", method: "POST", payload: { botId, amountWei } });
