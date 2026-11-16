// Single switch for the wallet implementation. MetaMask stays the default.
export const WALLET_MODES = ["metamask", "local"];

// Session-scoped admin override (set only by /admin-login after an admin address was verified). Only "metamask" is
// accepted: it lets an admin use MetaMask while the build runs the embedded wallet. Participants never set it.
export const WALLET_OVERRIDE_KEY = "walletModeOverride";
// Admin imported-key slot: the host opens the separate "admin" wallet instead of the participant wallet.
export const WALLET_SCOPE_OVERRIDE_KEY = "walletScopeOverride";

const readSession = (key) => {
  try { return globalThis.sessionStorage?.getItem(key) || ""; } catch { return ""; }
};
const writeSession = (key, value) => {
  try {
    if (value) globalThis.sessionStorage?.setItem(key, value);
    else globalThis.sessionStorage?.removeItem(key);
  } catch { /* storage unavailable: the override simply does not apply */ }
};
export const getWalletModeOverride = () => (readSession(WALLET_OVERRIDE_KEY) === "metamask" ? "metamask" : "");
export const setWalletModeOverride = () => writeSession(WALLET_OVERRIDE_KEY, "metamask");
export const getWalletScopeOverride = () => (readSession(WALLET_SCOPE_OVERRIDE_KEY) === "admin" ? "admin" : "");
export const setWalletScopeOverride = () => writeSession(WALLET_SCOPE_OVERRIDE_KEY, "admin");
export const clearWalletOverrides = () => { writeSession(WALLET_OVERRIDE_KEY, ""); writeSession(WALLET_SCOPE_OVERRIDE_KEY, ""); };
export const hasWalletOverride = () => Boolean(getWalletModeOverride() || getWalletScopeOverride());

// Written as `process.env.REACT_APP_WALLET_MODE` so Vite's `define` for `process.env` replaces it in the browser.
export const getWalletMode = (value = process.env.REACT_APP_WALLET_MODE) => {
  const raw = getWalletModeOverride() || value;
  const mode = String(raw || "metamask").trim().toLowerCase();
  if (!WALLET_MODES.includes(mode)) {
    throw new Error(`Unknown REACT_APP_WALLET_MODE "${mode}". Use one of: ${WALLET_MODES.join(", ")}.`);
  }
  return mode;
};

export const isEmbeddedWalletMode = (mode = getWalletMode()) => mode !== "metamask";

// Passphrase-protected local wallet (the pre-"invisible" behaviour). Off by default: participants never type anything.
// Written as `process.env.X` so Vite's `define` for `process.env` replaces it in the browser.
export const isPassphraseRequired = (value = process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE) =>
  String(value || "").trim().toLowerCase() === "required";

// True when the wallet is invisible to participants: local mode without the passphrase flow.
export const isInvisibleWalletMode = (mode = getWalletMode()) => mode === "local" && !isPassphraseRequired();
