// Who gets to see the Admin Zone entry points in the drawer. UI convenience only: the Admin Zone itself is still
// protected by the signed gate and the on-chain admin role. Participants never match any signal below.
import { useEffect, useState } from "react";
import { useAdminAccess } from "../pages/ManageBudget/useAdminAccess";
import { getAdminAddresses, isAdminAddress } from "../pages/ManageBudget/adminGate";
import { getWalletCopy } from "../real_ethereum/wallets/walletCopy";
import { getWalletScopeOverride, hasWalletOverride } from "../real_ethereum/wallets/walletMode.mjs";

export const ADMIN_HINT_KEY = "bc:admin-device-hint:v1";

const storage = () => {
  try { return globalThis.localStorage || null; } catch { return null; }
};

// Remembers (address only, no key and no proof) that an allowlisted admin signed in on this device.
export const rememberAdminDevice = (address, allowlist = getAdminAddresses()) => {
  if (!isAdminAddress(address, allowlist)) return;
  try {
    storage()?.setItem(ADMIN_HINT_KEY, JSON.stringify({ address: String(address).trim().toLowerCase(), at: Date.now() }));
  } catch { /* storage unavailable: the hint is optional */ }
};

export const forgetAdminDevice = () => {
  try { storage()?.removeItem(ADMIN_HINT_KEY); } catch { /* nothing to forget */ }
};

// True only while the remembered address is still on the allowlist.
export const hasAdminDeviceHint = (allowlist = getAdminAddresses()) => {
  try {
    const hint = JSON.parse(storage()?.getItem(ADMIN_HINT_KEY) || "null");
    return Boolean(hint) && isAdminAddress(hint.address, allowlist);
  } catch {
    return false;
  }
};

// Silent check of the MetaMask accounts this site is already connected to. Never prompts (eth_accounts only).
const readSilentMetaMaskAdmin = async () => {
  try {
    const accounts = await globalThis.window?.ethereum?.request?.({ method: "eth_accounts" });
    return Array.isArray(accounts) && accounts.some((account) => isAdminAddress(account));
  } catch {
    return false;
  }
};

export const useAdminEntry = () => {
  const adminAccess = useAdminAccess();
  const [silentMetaMaskAdmin, setSilentMetaMaskAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    const check = () => { readSilentMetaMaskAdmin().then((value) => { if (active) setSilentMetaMaskAdmin(value); }); };
    check();
    window.addEventListener("focus", check);
    return () => { active = false; window.removeEventListener("focus", check); };
  }, []);

  const knownAdmin =
    Boolean(adminAccess.isAdmin || adminAccess.onAllowlist) ||
    getWalletScopeOverride() === "admin" ||
    hasAdminDeviceHint() ||
    silentMetaMaskAdmin;

  return {
    showAdminZone: knownAdmin,
    showAdminSignIn: getWalletCopy().embedded && !hasWalletOverride() && knownAdmin && !adminAccess.isAdmin,
  };
};
