// Admin Zone UI gate.
//
// This is a FRONT-END gate only. The allowlist is public (REACT_APP_ADMIN_ADDRESSES is bundled
// into the page) and the contracts do not have an admin role yet, so nothing here protects
// contract writes: anyone can still call the contract functions directly from their own wallet.
import { verifyMessage } from "ethers";
import { buildSiweMessage, utf8ToHex } from "../../real_ethereum/siwe.mjs";
import { getTargetNetwork } from "../../real_ethereum/sapphireNetworks";

export const ADMIN_GATE_NOTE =
  "UI gate only: contract writes are not enforced until the contract has an admin role.";
export const ADMIN_GATE_STATEMENT =
  "Unlock the Admin Zone UI. This signature does not authorize any transaction.";
export const ADMIN_PROOF_MINUTES = 60;
const ADMIN_PROOF_KEY = "bc:admin-gate:proof:v1";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// "0xA, 0xb ; junk" -> unique, lowercased, valid addresses only.
export const parseAdminAddresses = (raw) => {
  const seen = new Set();
  String(raw ?? "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => ADDRESS.test(entry))
    .forEach((entry) => seen.add(entry));
  return Array.from(seen);
};

export const getAdminAddresses = () => parseAdminAddresses(process.env.REACT_APP_ADMIN_ADDRESSES);

export const isAdminAddress = (address, allowlist = getAdminAddresses()) => {
  const normalized = String(address ?? "").trim().toLowerCase();
  return ADDRESS.test(normalized) && allowlist.includes(normalized);
};

export const buildAdminGateMessage = ({ address, chainId, domain, uri, now, nonce }) =>
  buildSiweMessage({
    domain,
    address,
    uri,
    chainId,
    now,
    nonce,
    minutes: ADMIN_PROOF_MINUTES,
    statement: ADMIN_GATE_STATEMENT,
  });

const readMessageField = (message, label) => {
  const match = String(message).match(new RegExp(`^${label}: (.+)$`, "m"));
  return match ? match[1].trim() : "";
};

// What a proof must be bound to: the configured chain and the origin the app is served from.
export const getExpectedGateContext = () => ({
  chainId: getTargetNetwork().chainId,
  domain: typeof window !== "undefined" ? window.location.host : "",
  uri: typeof window !== "undefined" ? window.location.origin : "",
});

// Pure check: allowlisted + signature recovers the claimed address + message is ours, unexpired and
// bound to the expected chain id, domain and URI.
export const verifyAdminProof = ({
  address,
  message,
  signature,
  allowlist = getAdminAddresses(),
  now = Date.now(),
  expected = getExpectedGateContext(),
}) => {
  if (!isAdminAddress(address, allowlist)) return { ok: false, reason: "not-allowlisted" };
  const lines = String(message ?? "").split("\n");
  if (String(lines[1] ?? "").toLowerCase() !== String(address).toLowerCase() || !String(message).includes(ADMIN_GATE_STATEMENT)) {
    return { ok: false, reason: "bad-message" };
  }
  if (lines[0] !== `${expected.domain} wants you to sign in with your Ethereum account:`) {
    return { ok: false, reason: "wrong-domain" };
  }
  if (readMessageField(message, "URI") !== expected.uri) return { ok: false, reason: "wrong-uri" };
  if (readMessageField(message, "Chain ID") !== String(expected.chainId)) return { ok: false, reason: "wrong-chain" };
  const expiresAt = Date.parse(readMessageField(message, "Expiration Time"));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: "expired" };
  let recovered = "";
  try {
    recovered = verifyMessage(message, signature);
  } catch (_) {
    return { ok: false, reason: "bad-signature" };
  }
  if (recovered.toLowerCase() !== String(address).toLowerCase()) return { ok: false, reason: "bad-signature" };
  return { ok: true, expiresAt };
};

const storage = () => {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch (_) {
    return null;
  }
};

export const saveAdminProof = (proof) => {
  try {
    storage()?.setItem(ADMIN_PROOF_KEY, JSON.stringify(proof));
  } catch (_) {}
};

export const clearAdminProof = () => {
  try {
    storage()?.removeItem(ADMIN_PROOF_KEY);
  } catch (_) {}
};

// Returns the verified admin address for `account`, re-verifying the stored signature each time.
const readStoredProof = (account, { allowlist, now, expected } = {}) => {
  try {
    const stored = JSON.parse(storage()?.getItem(ADMIN_PROOF_KEY) || "null");
    if (!stored || String(stored.address).toLowerCase() !== String(account ?? "").toLowerCase()) return null;
    const result = verifyAdminProof({ ...stored, allowlist, now, expected });
    return result.ok ? { address: String(stored.address).toLowerCase(), expiresAt: result.expiresAt } : null;
  } catch (_) {
    return null;
  }
};

export const getVerifiedAdminAddress = (account, options = {}) => readStoredProof(account, options)?.address || "";

// Epoch ms when the stored proof for this account stops being valid (0 when there is none).
export const getAdminProofExpiry = (account, options = {}) => readStoredProof(account, options)?.expiresAt || 0;

// Ask the connected wallet to sign the gate message. Refuses (without prompting) non-allowlisted accounts.
export const requestAdminProof = async ({
  provider,
  account,
  chainId,
  domain,
  uri,
  allowlist = getAdminAddresses(),
  expected = { chainId, domain, uri },
}) => {
  if (!isAdminAddress(account, allowlist)) {
    throw new Error("This wallet address is not on the admin list.");
  }
  const message = buildAdminGateMessage({ address: account, chainId, domain, uri });
  const signature = await provider.request({
    method: "personal_sign",
    params: [utf8ToHex(message), account],
  });
  const result = verifyAdminProof({ address: account, message, signature, allowlist, expected });
  if (!result.ok) throw new Error(`Admin signature rejected (${result.reason}).`);
  const proof = { address: account, message, signature };
  saveAdminProof(proof);
  return proof;
};
