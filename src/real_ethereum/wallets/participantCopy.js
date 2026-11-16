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
