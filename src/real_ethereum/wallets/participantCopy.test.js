import { describeBidError } from "../../components/ContributeForm";
import { describeFinalizeError } from "../../pages/ShowAuction/ShowAuctionPage";
import { getTransactionErrorMessage } from "../../pages/ManageBudget/bulkAuctionUtils";
import { getWalletCopy } from "./walletCopy";
import { NEUTRAL_RETRY_MESSAGE, isInsufficientFundsError } from "./participantCopy";

const originalMode = process.env.REACT_APP_WALLET_MODE;
afterEach(() => { process.env.REACT_APP_WALLET_MODE = originalMode; delete process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE; });

const lowFunds = [
  new Error("insufficient funds for gas * price + value"),
  { shortMessage: "insufficient funds for intrinsic transaction cost" },
  new Error("gas required exceeds allowance"),
];
const forbidden = /wallet|test|gas|staff|contact|funds|MetaMask/i;

describe("invisible wallet (local mode, default)", () => {
  beforeEach(() => { process.env.REACT_APP_WALLET_MODE = "local"; });

  test.each(lowFunds)("a low native balance shows only the neutral message (%#)", (error) => {
    expect(isInsufficientFundsError(error)).toBe(true);
    for (const message of [describeBidError(error), describeFinalizeError(error), getTransactionErrorMessage(error)]) {
      expect(message).toBe(NEUTRAL_RETRY_MESSAGE);
      expect(message).toBe("Please wait a moment and try again.");
    }
  });

  test("other errors are not turned into the neutral message", () => {
    expect(describeBidError(new Error("Auction ended"))).not.toBe(NEUTRAL_RETRY_MESSAGE);
    expect(getTransactionErrorMessage(new Error("boom"))).toBe("Transaction failed. Please try again.");
  });

  test("participant-facing session copy has no wallet / TEST / gas / staff wording", () => {
    const copy = getWalletCopy();
    const text = [copy.verifying, copy.verifyingStatus, copy.requireWallet, copy.verificationFailed, copy.disconnected, copy.notDetected, ...Object.values(copy.reasons)].join(" | ");
    expect(text).not.toMatch(forbidden);
  });
});

describe("modes that keep the old wording", () => {
  test("MetaMask mode is unchanged", () => {
    process.env.REACT_APP_WALLET_MODE = "metamask";
    expect(describeBidError(lowFunds[0])).toMatch(/Not enough funds to pay the network fee \(gas\)/);
    expect(describeFinalizeError(lowFunds[0])).toMatch(/Add test funds to your wallet/);
    expect(getWalletCopy().verifying).toBe("Verifying your MetaMask connection");
  });
  test("the passphrase flow (REACT_APP_LOCAL_WALLET_PASSPHRASE=required) keeps its wording", () => {
    process.env.REACT_APP_WALLET_MODE = "local";
    process.env.REACT_APP_LOCAL_WALLET_PASSPHRASE = "required";
    expect(describeBidError(lowFunds[0])).toMatch(/Add test funds to your wallet/);
    expect(getWalletCopy().requireWallet).toMatch(/passphrase/);
  });
});
