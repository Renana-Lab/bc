/* eslint-env es2020 */
import { Component } from "react";
import FormControl from "@mui/material/FormControl";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Campaign from "../real_ethereum/campaign";
import { getEthereumAccounts } from "../real_ethereum/ethereumProvider";
import { readOnlyCall } from "../real_ethereum/readOnly";
import styles from "./../styles/components.module.scss";
import CircularProgress from "@mui/material/CircularProgress";
import { Typography } from "@mui/material";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import { chainNowMs, subscribeChainClock, BID_SAFETY_MARGIN_MS } from "../real_ethereum/chainClock";


  const ERROR_OUTBID = "You were outbid by another user";
  const ERROR_DEADLINE = "Your bid was submitted after the deadline";
  const ERROR_USER_DENIED_CONTRIBUTE = "You decided to cancel your bid";
  const USER_DENIED_PREFIX = "User denied transaction signature";
  const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };


const ERROR_NO_GAS = "Not enough funds to pay the network fee (gas). Add test funds to your wallet and try again.";
const ERROR_WALLET_LOCKED = "Your wallet is locked. Unlock it and try again.";
const ERROR_VERIFICATION = "Wallet verification expired. Re-check your wallet connection and try again.";

export const BID_MAX = 1000000000;

const toBig = (value) => {
  try {
    return BigInt(String(value ?? 0).split(".")[0] || 0);
  } catch (_error) {
    return 0n;
  }
};

// Smallest total bid the contract accepts now: max(minimum, highest + 1, myBid + 1).
export const minimumAcceptedBid = (minimum, highest, myBid) => {
  const candidates = [toBig(minimum), toBig(highest) + 1n, toBig(myBid) + 1n];
  return candidates.reduce((best, value) => (value > best ? value : best), 0n);
};

const budgetLabel = (budget) =>
  budget === Infinity || budget === null || budget === undefined ? "unknown" : String(budget);

export const bidRangeMessage = (minimumAccepted, budget) =>
  `Your total bid must be at least ${minimumAccepted} and the increase must fit your remaining budget (${budgetLabel(budget)}).`;

// Maps a failed bid to a message that matches the real cause.
export function describeBidError(err, auctionClosed = false) {
  const message = String(err?.message || err?.data?.message || "");
  const code = err?.code ?? err?.cause?.code;
  if (code === 4001 || message.includes(USER_DENIED_PREFIX)) return ERROR_USER_DENIED_CONTRIBUTE;
  if (code === 4100) return ERROR_WALLET_LOCKED;
  if (/insufficient funds/i.test(message)) return ERROR_NO_GAS;
  if (/verification (expired|failed|timed out)|verify your metamask connection|unlock your wallet with your passphrase before continuing/i.test(message)) return ERROR_VERIFICATION;
  if (/Bid must exceed current highest/i.test(message)) return ERROR_OUTBID;
  if (/Auction ended/i.test(message) || auctionClosed) return ERROR_DEADLINE;
  return message || "Your bid could not be placed.";
}

class ContributeForm extends Component {
  state = {
    bidAmount: "",
    errorMessage: "",
    successMessage: "",
    transactionIsLoading: false,
    error: false,
    weiInfoClicked: false,
    clockTick: 0,
  };

  componentDidMount() {
    this.unsubscribeClock = subscribeChainClock(() => this.bumpClock());
    this.clockInterval = setInterval(() => this.bumpClock(), 1000);
  }

  componentWillUnmount() {
    this.unsubscribeClock?.();
    clearInterval(this.clockInterval);
  }

  bumpClock = () => this.setState((prev) => ({ clockTick: prev.clockTick + 1 }));

  // Remaining time to the deadline on chain time, or null when the end time is unknown.
  getRemainingMs = () => {
    const endMs = Number(this.props.endTime) * 1000;
    if (!Number.isFinite(endMs) || endMs <= 0) return null;
    return endMs - chainNowMs();
  };

  onSubmit = async (event) => {
    event.preventDefault();
    this.setState({
      transactionIsLoading: true,
      error: false,
      errorMessage: "",
      successMessage: "",
    });

    const {
      address,
      remainingBudget,
      onSuccessfulBid,
      userBid = 0,
    } = this.props;
    const campaign = Campaign(address);
    let summary;
    let summaryIsLight = true;

    try {
      summary = await readOnlyCall(
        ({ campaign: readOnlyCampaign }) =>
          readOnlyCampaign(address).methods.getListSummary(),
        undefined,
        READ_OPTIONS
      );
    } catch (error) {
      summaryIsLight = false;
      summary = await readOnlyCall(
        ({ campaign: readOnlyCampaign }) =>
          readOnlyCampaign(address).methods.getSummary(),
        undefined,
        READ_OPTIONS
      );
    }

    const minimumContribution = summary[0];
    const manager = summary[3];
    const highestBid = summary[4];
    const endTime = summaryIsLight ? summary[7] : summary[8];
    const accounts = await getEthereumAccounts();
    const connectedAccount = accounts[0];

    if (!/^\d+$/.test(String(this.state.bidAmount || ""))) {
      this.setState({
        error: true,
        errorMessage: "Bid amount must be a whole number in wei",
        transactionIsLoading: false,
      });
      return;
    }

    const newBid = BigInt(this.state.bidAmount);
    const currentUserBid = BigInt(String(userBid || 0));
    const highestBidValue = BigInt(String(highestBid || 0));
    const minimumContributionValue = BigInt(String(minimumContribution || 0));
    const remainingBudgetValue =
      remainingBudget === Infinity ? null : BigInt(String(remainingBudget || 0));
    const additionalBid =
      newBid > currentUserBid ? newBid - currentUserBid : 0n;

    // Basic validations
    if (newBid <= 0n) {
      this.setState({
        error: true,
        errorMessage: "Bid amount must be greater than 0",
        transactionIsLoading: false,
      });
      return;
    }
    const minimumAccepted = minimumAcceptedBid(
      minimumContributionValue,
      highestBidValue,
      currentUserBid,
    );
    if (
      newBid < minimumAccepted ||
      (remainingBudgetValue !== null && additionalBid > remainingBudgetValue)
    ) {
      this.setState({
        error: true,
        errorMessage: bidRangeMessage(minimumAccepted.toString(), remainingBudget),
        transactionIsLoading: false,
      });
      return;
    }
    if (Number(endTime + "000") - chainNowMs() < BID_SAFETY_MARGIN_MS) {
      this.setState({
        error: true,
        errorMessage: "You cannot contribute to a closed auction!",
        transactionIsLoading: false,
      });
      return;
    }
    if (connectedAccount.toLowerCase() === manager.toLowerCase()) {
      this.setState({
        error: true,
        errorMessage: "You cannot contribute to your own auction!",
        transactionIsLoading: false,
      });
      return;
    }

    try {


      const receipt = await campaign.methods.contribute().send({
        from: connectedAccount,
        value: additionalBid.toString(),
      });
      const bidRecordedEvent = Array.isArray(receipt?.events?.BidRecorded)
        ? receipt.events.BidRecorded[0]
        : receipt?.events?.BidRecorded;
      const budgetAfter = bidRecordedEvent?.returnValues?.budgetAfter;

      await onSuccessfulBid?.({
        totalBid: newBid.toString(),
        additionalBid: additionalBid.toString(),
        budgetAfter,
        address,
        receipt,
      });

      this.setState({
        bidAmount: "",
        transactionIsLoading: false,
        successMessage: "Bid placed successfully!",
      });
    } catch (err) {

        const message = describeBidError(err, Number(endTime + "000") < chainNowMs());
        this.setState({
          transactionIsLoading: false,
          error: true,
          errorMessage: message,
        });
    }
  };

  onReveal = (event) => {
    this.setState({ weiInfoClicked: true });
  };

  render() {
    const { userBid = 0 } = this.props;
    const newBid = Number(this.state.bidAmount);
    const difference = newBid > userBid ? newBid - userBid : 0;
    const minimumAccepted = minimumAcceptedBid(
      this.props.minimumContribution,
      this.props.highestBid,
      userBid,
    ).toString();
    const budgetValue = this.props.remainingBudget;
    const budgetCap =
      budgetValue === Infinity || budgetValue === null || budgetValue === undefined
        ? BID_MAX
        : Number(budgetValue);
    const maxBid = Math.min(BID_MAX, (this.props.isLeader ? Number(userBid) : 0) + budgetCap);
    const remainingMs = this.getRemainingMs();
    const auctionEnded = remainingMs !== null && remainingMs <= 0;
    const bidWindowClosed = remainingMs !== null && remainingMs < BID_SAFETY_MARGIN_MS;

    return (
      <FormControl>
        <div className={styles.tooltip}>
          <label className={styles.tooltiplabe} htmlFor="total-bid">
            Total Bid
          </label>
          <Tooltip
            enterTouchDelay={0}
            title={`Enter your total bid, including any amount you already bid (${userBid}). When you lead, only the increase is reserved; otherwise the full total is reserved. Minimum accepted now: ${minimumAccepted}. If another bidder takes the lead, your reserved budget is released. Amounts are in wei.`}
          >
            <IconButton size="small" aria-label="How total bids work">?</IconButton>
          </Tooltip>
        </div>

        <TextField
          id="total-bid"
          type="number"
          style={{
            borderRadius: ".5rem",
            backgroundColor: "#D8DCF0",
            color: "#002884",
            fontWeight: "600",
            border: "1px solid #002884",
          }}
          value={this.state.bidAmount}
          disabled={this.state.transactionIsLoading}
          inputProps={{ min: minimumAccepted, max: maxBid, step: 1 }}
          onChange={(event) => this.setState({ bidAmount: event.target.value })}
        />

        {/* 💬 Display how much will be charged */}
        {difference > 0 && (
          <Typography
            fontSize="0.9rem"
            sx={{ marginTop: "0.5rem", color: "#555" }}
          >
          </Typography>
        )}

        {this.state.successMessage && (
          <Alert severity="success" role="status" sx={{ marginTop: "1rem" }}>
            {this.state.successMessage}
          </Alert>
        )}

        {this.state.error && (
          <Alert severity="error" role="alert" sx={{ marginTop: "1rem" }}>
            {this.state.errorMessage}
          </Alert>
        )}

        <Button
          style={{
            marginTop: "2rem",
            height: "2.5rem",
            padding: "0.8rem",
            borderRadius: "1rem",
            backgroundColor: "#002884",
            color: "#D8DCF0",
            fontWeight: "600",
            border: "1px solid #002884",
            minWidth: "11rem",
          }}
          onClick={this.onSubmit}
          disabled={this.state.transactionIsLoading || bidWindowClosed || this.props.noBudget}
        >
          {!this.state.transactionIsLoading ? (
            <span>{auctionEnded ? "Auction ended" : this.props.noBudget ? "No budget left" : "Submit your bid"}</span>
          ) : (
            <span>
              <CircularProgress className={styles.progress} size={14} /> Submitting...
            </span>
          )}
        </Button>
      </FormControl>
    );
  }
}

export default ContributeForm;
