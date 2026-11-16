// The separate "admin" wallet slot (local wallet mode): imported/restored admin keys live here, never in the
// participant wallet. Kept free of chain/network imports so the wallet host can use it cheaply.
import { Wallet } from "ethers";
import { createIndexedDbStorage } from "./localWallet.mjs";
import { createSilentVault } from "./silentVault.mjs";
import { setWalletScopeOverride } from "./walletMode.mjs";

// MetaMask exports keys without the 0x prefix; accept both.
export const normalizePrivateKey = (value) => {
  const text = String(value || "").trim();
  return /^[0-9a-fA-F]{64}$/.test(text) ? `0x${text}` : text;
};

// Restores a passphrase-encrypted backup into the "admin" slot (never over the participant wallet) and points this
// tab session at it. `confirmReplace` is asked only when an admin wallet already exists in this browser.
export const restoreAdminBackup = async ({
  json, passphrase, silentStorage = createIndexedDbStorage({ storeName: "silent" }), confirmReplace = () => true,
}) => {
  const decrypted = await Wallet.fromEncryptedJson(json, passphrase).catch(() => {
    throw new Error("Backup could not be decrypted with that passphrase.");
  });
  const vault = createSilentVault({ storage: silentStorage, scope: "admin" });
  if ((await vault.exists()) && !(await confirmReplace())) {
    return { ok: false, cancelled: true, message: "Restore cancelled. The current admin wallet was kept." };
  }
  await vault.seal(decrypted.privateKey);
  setWalletScopeOverride();
  return { ok: true, account: decrypted.address };
};
