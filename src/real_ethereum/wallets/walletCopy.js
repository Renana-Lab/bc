import { getWalletMode, isEmbeddedWalletMode, isInvisibleWalletMode } from "./walletMode.mjs";

// All wallet-facing wording for the active wallet mode. MetaMask-mode strings are the
// original ones, byte for byte; local (embedded wallet) mode never mentions MetaMask.
const METAMASK = {
  embedded: false,
  walletName: "MetaMask",
  loginPath: "/metamask-login",
  verifying: "Verifying your MetaMask connection",
  verifyingStatus: "Checking wallet access",
  disconnected: "MetaMask disconnected. Unlock it and reconnect.",
  notDetected: "A verifiable MetaMask extension was not detected. Enable it for this site and retry.",
  timeout: "MetaMask verification timed out. Open the extension and retry.",
  cannotVerifyUnlock: "This wallet cannot verify its unlock state. Update the MetaMask extension and retry.",
  invalidAccounts: "MetaMask returned an invalid account response.",
  reasons: {
    locked: "Unlock MetaMask to continue.",
    unauthorized: "Connect an account to this website in MetaMask.",
    "verification-failed": "MetaMask unlock state could not be verified.",
  },
  verificationFailed: "MetaMask verification failed or timed out. Unlock or update the extension and retry.",
  requireWallet: "Verify your MetaMask connection before continuing.",
  connectRejected: "MetaMask connection was rejected. Approve the connection to continue.",
  connectPending: "MetaMask has a pending request. Open the extension and finish it.",
  connectFailed: "Could not verify MetaMask access. Unlock the extension, connect an account to this site, and retry.",
  txPending: "MetaMask has a pending transaction. Wait for it, or speed/cancel it in Activity.",
  txRejected: "Transaction rejected in MetaMask.",
  noProviderRedirect: "Redirect away if no MetaMask",
  showTutorial: true,
  tutorialLink: "https://support.metamask.io/start/getting-started-with-metamask/",
  seo: {
    description:
      "A Web3 research data auction platform where sellers open blockchain-backed data auctions and bidders participate through MetaMask on Ethereum Sepolia.",
    loginTitle: "Connect MetaMask | Blockchain Data Market",
    loginDescription:
      "Check your MetaMask connection before entering the Blockchain Data Market auction platform.",
  },
};

const LOCAL = {
  embedded: true,
  walletName: "your local wallet",
  loginPath: "/wallet-unlock",
  verifying: "Checking your wallet...",
  verifyingStatus: "Checking wallet access",
  disconnected: "Your wallet disconnected. Unlock it with your passphrase.",
  notDetected: "Your local wallet is not available yet. Unlock your wallet with your passphrase.",
  timeout: "Wallet verification timed out. Please retry.",
  cannotVerifyUnlock: "This wallet cannot verify its unlock state. Reload the page and retry.",
  invalidAccounts: "Your wallet returned an invalid account response.",
  reasons: {
    locked: "Unlock your wallet with your passphrase.",
    unauthorized: "Create or unlock your wallet with your passphrase.",
    "verification-failed": "Your wallet's unlock state could not be verified.",
  },
  verificationFailed: "Wallet verification failed or timed out. Unlock your wallet and retry.",
  requireWallet: "Unlock your wallet with your passphrase before continuing.",
  connectRejected: "Wallet connection was rejected. Unlock your wallet to continue.",
  connectPending: "Your wallet has a pending request. Finish it in the wallet panel.",
  connectFailed: "Could not verify your wallet. Unlock it with your passphrase and retry.",
  txPending: "Your wallet has a pending transaction. Wait for it to finish.",
  txRejected: "Transaction rejected in your wallet.",
  noProviderRedirect: "Redirect away if the wallet is unavailable",
  showTutorial: false,
  tutorialLink: "",
  seo: {
    description:
      "A Web3 research data auction platform where sellers open blockchain-backed data auctions and bidders participate with an embedded wallet on the Oasis Sapphire testnet.",
    loginTitle: "Unlock your wallet | Blockchain Data Market",
    loginDescription:
      "Unlock your wallet with your passphrase before entering the Blockchain Data Market auction platform on the Oasis Sapphire testnet.",
  },
};

// Invisible-wallet participants never see "wallet" wording (the wallet is created and unlocked silently).
const INVISIBLE = {
  ...LOCAL,
  walletName: "your session",
  verifying: "Preparing your session...",
  verifyingStatus: "Preparing your session",
  disconnected: "Please wait a moment and try again.",
  notDetected: "Please wait a moment and try again.",
  timeout: "Please wait a moment and try again.",
  cannotVerifyUnlock: "Please reload the page and try again.",
  invalidAccounts: "Please reload the page and try again.",
  reasons: {
    locked: "Please wait a moment and try again.",
    unauthorized: "Please wait a moment and try again.",
    "verification-failed": "Please wait a moment and try again.",
  },
  verificationFailed: "Please wait a moment and try again.",
  requireWallet: "Please wait a moment and try again.",
  connectRejected: "Please wait a moment and try again.",
  connectPending: "Please wait a moment and try again.",
  connectFailed: "Please wait a moment and try again.",
  txPending: "Please wait a moment and try again.",
  txRejected: "The action was cancelled.",
  seo: {
    description: "A research data auction platform.",
    loginTitle: "Preparing your session | Blockchain Data Market",
    loginDescription: "Your session is being prepared.",
  },
};

export const getWalletCopy = (mode = getWalletMode()) => {
  if (!isEmbeddedWalletMode(mode)) return METAMASK;
  return isInvisibleWalletMode(mode) ? INVISIBLE : LOCAL;
};

export const isLocalWalletCopy = () => getWalletCopy().embedded;
