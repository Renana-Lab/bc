// Single switch for the wallet implementation. MetaMask stays the default.
export const WALLET_MODES = ["metamask", "privy", "local"];

export const getWalletMode = (value) => {
  const raw = value ?? (typeof process !== "undefined" ? process.env?.REACT_APP_WALLET_MODE : "");
  const mode = String(raw || "metamask").trim().toLowerCase();
  if (!WALLET_MODES.includes(mode)) {
    throw new Error(`Unknown REACT_APP_WALLET_MODE "${mode}". Use one of: ${WALLET_MODES.join(", ")}.`);
  }
  return mode;
};

export const isEmbeddedWalletMode = (mode = getWalletMode()) => mode !== "metamask";
