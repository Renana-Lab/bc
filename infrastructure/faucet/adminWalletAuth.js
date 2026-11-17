"use strict";
// Admin authentication with the signed-in admin wallet (no password).
//
// The browser sends the same proof the Admin Zone gate stores (src/pages/ManageBudget/adminGate.js):
//   x-admin-proof = base64url(JSON { address, message, signature })
// where message is an EIP-4361 text signed with the admin wallet (personal_sign). The server checks that the message is bound to
// one of our allowed web origins, this chain and this purpose, that it is fresh, that the signature recovers the claimed
// address, and finally that the address holds the admin role on the factory (isAdmin(address), one eth_call).
// Nothing here is ever logged: not the proof, not the signature.
const { verifyMessage } = require("ethers");

// Must stay identical to ADMIN_GATE_STATEMENT in src/pages/ManageBudget/adminGate.js (the tests compare them).
const ADMIN_GATE_STATEMENT = "Unlock the Admin Zone UI. This signature does not authorize any transaction.";
const MAX_PROOF_BYTES = 4096;
const SKEW_MS = 60_000;
const MAX_AGE_MS = 61 * 60_000;
const MAX_LIFETIME_MS = 61 * 60_000;
const ROLE_TTL_TRUE_MS = 60_000;
const ROLE_TTL_FALSE_MS = 10_000;
const IS_ADMIN_SELECTOR = "0x24d7806c"; // isAdmin(address)
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const fail = (reason) => ({ ok: false, reason });

const field = (message, label) => {
  const match = String(message).match(new RegExp(`^${label}: (.+)$`, "m"));
  return match ? match[1].trim() : "";
};

const decodeProof = (header) => {
  if (typeof header !== "string" || !header || header.length > Math.ceil((MAX_PROOF_BYTES * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(header)) return null;
  const raw = Buffer.from(header.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length === 0 || raw.length > MAX_PROOF_BYTES) return null;
  try {
    const proof = JSON.parse(raw.toString("utf8"));
    return proof && typeof proof === "object" && !Array.isArray(proof) ? proof : null;
  } catch {
    return null;
  }
};

// chain.call({ to, data }) -> 0x hex result (the existing RPC_URL provider in production, a fake in tests).
const createAdminWalletAuth = ({ chain, factoryAddress, chainId, allowedOrigins = [], now = () => Date.now() }) => {
  const enabled = ADDRESS.test(String(factoryAddress || "")) && typeof chain?.call === "function";
  const origins = new Set((allowedOrigins || []).map((origin) => String(origin).trim().replace(/\/+$/, "")));
  const roleCache = new Map(); // lowercased address -> { value, until }

  const checkMessage = (address, message) => {
    const lines = String(message).split("\n");
    const match = /^(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] || "");
    if (!match) return "bad-message";
    const origin = `https://${match[1]}`;
    if (!origins.has(origin)) return "wrong-origin";
    if (field(message, "URI") !== origin) return "wrong-uri";
    if (String(lines[1] ?? "").toLowerCase() !== address.toLowerCase()) return "bad-message";
    if (!String(message).includes(ADMIN_GATE_STATEMENT)) return "bad-message";
    if (field(message, "Chain ID") !== String(chainId)) return "wrong-chain";
    const issuedAt = Date.parse(field(message, "Issued At"));
    const expiresAt = Date.parse(field(message, "Expiration Time"));
    const t = now();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return "bad-message";
    if (issuedAt > t + SKEW_MS) return "future";
    if (t - issuedAt > MAX_AGE_MS) return "expired";
    if (expiresAt <= t) return "expired";
    if (expiresAt - issuedAt > MAX_LIFETIME_MS) return "bad-lifetime";
    return "";
  };

  // true / false, or throws when the chain cannot be asked (the caller turns that into "rpc", never into access).
  const isOnChainAdmin = async (address) => {
    const key = address.toLowerCase();
    const t = now();
    const cached = roleCache.get(key);
    if (cached && cached.until > t) return cached.value;
    const data = `${IS_ADMIN_SELECTOR}${key.slice(2).padStart(64, "0")}`;
    const result = await chain.call({ to: factoryAddress, data });
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error("bad eth_call result");
    const value = result.length === 66 && BigInt(result) === 1n;
    roleCache.set(key, { value, until: t + (value ? ROLE_TTL_TRUE_MS : ROLE_TTL_FALSE_MS) });
    if (roleCache.size > 500) for (const [k, v] of roleCache) if (v.until <= t) roleCache.delete(k);
    return value;
  };

  // header -> { ok: true, address } | { ok: false, reason }
  const verify = async (header) => {
    if (!enabled) return fail("disabled");
    const proof = decodeProof(header);
    if (!proof) return fail("bad-proof");
    const { address, message, signature } = proof;
    if (typeof address !== "string" || !ADDRESS.test(address) || typeof message !== "string" || typeof signature !== "string") return fail("bad-proof");
    const problem = checkMessage(address, message);
    if (problem) return fail(problem);
    let recovered = "";
    try { recovered = verifyMessage(message, signature); } catch { return fail("bad-signature"); }
    if (recovered.toLowerCase() !== address.toLowerCase()) return fail("bad-signature");
    try {
      return (await isOnChainAdmin(address)) ? { ok: true, address: address.toLowerCase() } : fail("not-admin");
    } catch {
      return fail("rpc");
    }
  };

  return { enabled, verify };
};

module.exports = { createAdminWalletAuth, ADMIN_GATE_STATEMENT, IS_ADMIN_SELECTOR };
