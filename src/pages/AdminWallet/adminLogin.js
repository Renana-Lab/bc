// MetaMask admin sign-in for builds that run the embedded wallet (REACT_APP_WALLET_MODE=local).
import { Wallet } from "ethers";
import { isAdminAddress } from "../ManageBudget/adminGate";
import { readFactoryOwner, readIsFactoryAdmin } from "../../real_ethereum/adminChain";
import { ensureTargetChain } from "../../real_ethereum/sapphireNetworks";
import { createIndexedDbStorage } from "../../real_ethereum/wallets/localWallet.mjs";
import { createSilentVault } from "../../real_ethereum/wallets/silentVault.mjs";
import { setWalletModeOverride, setWalletScopeOverride } from "../../real_ethereum/wallets/walletMode.mjs";
import { normalizePrivateKey, restoreAdminBackup } from "../../real_ethereum/wallets/adminSlot";

export { normalizePrivateKey, restoreAdminBackup };

// The admin wallet sees MetaMask directly (walletAccess ignores window.ethereum in local mode).
export const findMetaMaskProvider = ({ waitMs = 300 } = {}) => new Promise((resolve) => {
  if (typeof window === "undefined") { resolve(null); return; }
  const announced = [];
  const onAnnounce = (event) => { if (event.detail?.info?.rdns === "io.metamask" && event.detail.provider?.request) announced.push(event.detail.provider); };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(() => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    if (announced.length) { resolve(announced[0]); return; }
    const injected = window.ethereum?.providers || [window.ethereum];
    resolve(injected.find((provider) => provider?.isMetaMask && typeof provider.request === "function") || null);
  }, waitMs);
});

// On-chain admin/owner role, read-only. Uses the same readers as useAdminAccess (its default readIsAdmin / readOwner).
export const readOnChainAdminRole = async (account, { readIsAdmin = readIsFactoryAdmin, readOwner = readFactoryOwner } = {}) => {
  const [admin, owner] = await Promise.all([
    Promise.resolve(readIsAdmin(account)).catch(() => false),
    Promise.resolve(readOwner()).catch(() => ""),
  ]);
  return Boolean(admin) || (Boolean(owner) && String(owner).toLowerCase() === String(account).toLowerCase());
};

// Resolves { ok: true, account } after setting the override, or { ok: false, message } without touching it.
export const connectAdminWithMetaMask = async ({ findProvider = findMetaMaskProvider, allowlist, extraAdminCheck } = {}) => {
  const provider = await findProvider();
  if (!provider) return { ok: false, message: "MetaMask was not detected. Enable the extension for this site and retry." };
  let account;
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    await ensureTargetChain(provider);
    account = String(accounts?.[0] || "");
  } catch (error) {
    return { ok: false, message: error?.code === 4001 ? "The connection was rejected in MetaMask." : "Could not connect MetaMask. Unlock it and retry." };
  }
  let admin = isAdminAddress(account, allowlist);
  if (!admin && extraAdminCheck) {
    try { admin = Boolean(await extraAdminCheck(account)); } catch { admin = false; }
  }
  if (!admin) return { ok: false, message: "This account is not an admin." };
  setWalletModeOverride();
  return { ok: true, account };
};

// Optional fallback: a pasted testnet private key, sealed with the same non-extractable WebCrypto scheme in a
// separate "admin" slot. Only an address on the admin list is accepted.
export const importAdminKey = async ({ privateKey, allowlist, silentStorage = createIndexedDbStorage({ storeName: "silent" }) }) => {
  let wallet;
  try { wallet = new Wallet(normalizePrivateKey(privateKey)); } catch { return { ok: false, message: "That is not a valid private key." }; }
  if (!isAdminAddress(wallet.address, allowlist)) return { ok: false, message: "This account is not an admin." };
  await createSilentVault({ storage: silentStorage, scope: "admin" }).seal(wallet.privateKey);
  setWalletScopeOverride();
  return { ok: true, account: wallet.address };
};
