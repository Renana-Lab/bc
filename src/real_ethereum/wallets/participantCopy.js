import { isInvisibleWalletMode } from "./walletMode.mjs";

// Participants of the invisible-wallet experiment never see wallet, TEST, gas or staff wording.
// When a transaction fails for lack of native funds they only get this neutral line, on the failed action.
export const NEUTRAL_RETRY_MESSAGE = "Please wait a moment and try again.";

export const isInsufficientFundsError = (error) =>
  /insufficient funds|gas required exceeds|not enough funds|insufficient balance|exceeds (the )?balance/i.test(
    String(error?.message || error?.data?.message || error?.cause?.message || error?.shortMessage || "")
  );

// `original` is the existing wallet-oriented text; it is kept verbatim outside the invisible-wallet mode.
export const participantMessage = (original) => (isInvisibleWalletMode() ? NEUTRAL_RETRY_MESSAGE : original);

// Participant-visible wording that differs between the market (non-blockchain) release and the MetaMask build.
// Each entry is { invisible, original }: the market text is returned in invisible-wallet mode, the existing text
// (byte for byte) otherwise. A value may be a function of `params` for strings with a conditional part.
const PARTICIPANT_TEXT = {
  homeBody: {
    invisible:
      "This is a research platform, for running\nauctions of personal data using the marketplace budget.\nEach auction lasts up to 30 mins.",
    original:
      "This is a blockchain based research platform, for running\nauctions of personal data using cryptocurrency.\nEach auction lasts up to 30 mins.",
  },
  homeImageAlt: {
    invisible: "Research data marketplace illustration",
    original: "Blockchain data marketplace illustration",
  },
  brand: { invisible: "Data Marketplace", original: "Blockchain Data Market" },
  listHero: {
    invisible: "Welcome to the Data Marketplace Platform",
    original: "Welcome to the Blockchain Data Market Platform",
  },
  listHeroAlt: {
    invisible: "Research auction marketplace dashboard",
    original: "Blockchain auction marketplace dashboard",
  },
  createImageAlt: { invisible: "Create a data auction", original: "Create a blockchain data auction" },
  sellerLabel: { invisible: "Seller identifier", original: "Seller address" },
  minBidLabel: { invisible: "Minimum bid required", original: "Minimum bid" },
  highestBidLabel: { invisible: "Highest bid recorded", original: "Highest bid" },
  countdownEnded: { invisible: "Closed", original: "Ended" },
  csvTxAmount: { invisible: "Tx Amount", original: "Transaction Amount (wei)" },
  csvCumulativeBid: { invisible: "Cumulative Bid", original: "Cumulative Bid (wei)" },
  searchPlaceholder: {
    invisible: "Search auctions by description, seller identifier, or exact bid",
    original: "Search auctions by description, address, or exact bid",
  },
  minBidTooltip: {
    invisible: ({ allowSellerEdit } = {}) =>
      "The lowest price you are willing to accept for selling your information (in cents)." +
      (allowSellerEdit ? " You can change this price at any time before the first bid is placed." : ""),
    original: () => "The lowest price you are willing to accept for selling your information (in wei).",
  },
};

export const participantText = (key, params) => {
  const entry = PARTICIPANT_TEXT[key];
  if (!entry) throw new Error(`Unknown participant text "${key}"`);
  const value = isInvisibleWalletMode() ? entry.invisible : entry.original;
  return typeof value === "function" ? value(params) : value;
};

export const PARTICIPANT_TEXT_KEYS = Object.keys(PARTICIPANT_TEXT);

// "0x1234abcd...ef" -> "0x1234...abcd"; anything that is not a long hex string is returned unchanged.
export const shortIdentifier = (value) => {
  const text = String(value ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
};
