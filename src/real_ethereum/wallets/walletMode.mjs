// Single switch for the wallet implementation. MetaMask stays the default.
export const WALLET_MODES = ["metamask", "privy", "local"];

// Written as `process.env.REACT_APP_WALLET_MODE` so Vite's `define` for `process.env` replaces it in the browser.
export const getWalletMode = (value = process.env.REACT_APP_WALLET_MODE) => {
  const raw = value;
  const mode = String(raw || "metamask").trim().toLowerCase();
  if (!WALLET_MODES.includes(mode)) {
    throw new Error(`Unknown REACT_APP_WALLET_MODE "${mode}". Use one of: ${WALLET_MODES.join(", ")}.`);
  }
  return mode;
};

export const isEmbeddedWalletMode = (mode = getWalletMode()) => mode !== "metamask";
