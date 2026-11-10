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
import toast from "react-hot-toast";


  const ERROR_OUTBID = "You were outbid by another user";
  const ERROR_DEADLINE = "Your bid was submitted after the deadline";
  const ERROR_USER_DENIED_CONTRIBUTE = "You decided to cancel your bid";
  const USER_DENIED_PREFIX = "User denied transaction signature";
  const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };


const ERROR_NO_GAS = "Not enough funds to pay the network fee (gas). Add test funds to your wallet and try again.";
const ERROR_WALLET_LOCKED = "Your wallet is locked. Unlock it and try again.";
const ERROR_VERIFICATION = "Wallet verification expired. Re-check your wallet connection and try again.";

// Maps a failed bid to a message that matches the real cause.
export function describeBidError(err, auctionClosed = false) {
  const message = String(err?.message || err?.data?.message || "");
  const code = err?.code ?? err?.cause?.code;
  if (code === 4001 || message.includes(USER_DENIED_PREFIX)) return ERROR_USER_DENIED_CONTRIBUTE;
  if (code === 4100) return ERROR_WALLET_LOCKED;
  if (/insufficient funds/i.test(message)) return ERROR_NO_GAS;
  if (/verification (expired|failed|timed out)|verify your metamask connection/i.test(message)) return ERROR_VERIFICATION;
  if (/Bid must exceed current highest/i.test(message)) return ERROR_OUTBID;
  if (/Auction ended/i.test(message) || auctionClosed) return ERROR_DEADLINE;
  return message || "Your bid could not be placed.";
}

class ContributeForm extends Component {
  state = {
    bidAmount: "",
    errorMessage: "",
    transactionIsLoading: false,
    error: false,
    weiInfoClicked: false,
  };

  onSubmit = async (event) => {
    event.preventDefault();
    this.setState({
      transactionIsLoading: true,
      error: false,
      errorMessage: "",
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
    if (newBid <= currentUserBid || newBid <= highestBidValue) {
      this.setState({
        error: true,
        errorMessage: `Your new bid must be greater than the highest bid - ${highestBid} wei`,
        transactionIsLoading: false,
      });
      return;
    }
    if (remainingBudgetValue !== null && additionalBid > remainingBudgetValue) {
      this.setState({
        error: true,
        errorMessage: `Insufficient budget. You need ${additionalBid.toString()} more wei for this bid.`,
        transactionIsLoading: false,
      });
      return;
    }
    if (newBid < minimumContributionValue) {
      this.setState({
        error: true,
        errorMessage: `Total bid must exceed the minimum required of ${minimumContribution} wei.`,
        transactionIsLoading: false,
      });
      return;
    }
    if (Number(endTime + "000") < Date.now()) {
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

      toast.success(
        `Bid placed successfully!`
      );
      await onSuccessfulBid?.({
        totalBid: newBid.toString(),
        additionalBid: additionalBid.toString(),
        budgetAfter,
        address,
        receipt,
      });

      this.setState({ bidAmount: "", transactionIsLoading: false });
    } catch (err) {

        const message = describeBidError(err, Number(endTime + "000") < Date.now());
        toast.error(message);

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

    return (
      <FormControl>
        <div className={styles.tooltip}>
          <label className={styles.tooltiplabe}>
            Total Bid (in Wei)
            <button onClick={this.onReveal} className={styles.circleIcon}>
              ?
            </button>
            <div className={styles.description}>
              {this.state.weiInfoClicked && (
                <Typography fontStyle="italic">
                  Wei is the smallest (base) unit of Ether. You can convert
                  between Ether units
                  <a
                    href="https://eth-converter.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {" "}
                    here.
                  </a>
                </Typography>
              )}
            </div>
          </label>
        </div>

        <TextField
          type="number"
          style={{
            borderRadius: ".5rem",
            backgroundColor: "#D8DCF0",
            color: "#002884",
            fontWeight: "600",
            border: "1px solid #002884",
          }}
          value={this.state.bidAmount}
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

        {this.state.error && (
          <Alert severity="error" sx={{ marginTop: "1rem" }}>
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
          disabled={this.state.transactionIsLoading}
        >
          {!this.state.transactionIsLoading ? (
            <span>Submit your bid</span>
          ) : (
            <CircularProgress className={styles.progress} size={20} />
          )}
        </Button>
      </FormControl>
    );
  }
}

export default ContributeForm;
