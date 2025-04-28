import React, { Component } from "react";
import FormControl from "@mui/material/FormControl";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Campaign from "../real_ethereum/campaign";
import web3 from "../real_ethereum/web3";
import styles from "./../styles/components.module.scss";
import CircularProgress from "@mui/material/CircularProgress";
import { Typography } from "@mui/material";
import toast from "react-hot-toast";

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
    this.setState({ transactionIsLoading: true, error: false, errorMessage: "" });

    const { address, remainingBudget, onSuccessfulBid } = this.props;
    const campaign = Campaign(address);
    const summary = await campaign.methods.getSummary().call();
    const minimumContribution = summary[0];
    const endTime = summary[7];
    const manager = summary[3];
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const connectedAccount = accounts[0];
    const monney = await campaign.methods.getBid(connectedAccount).call();
    let val = Number(monney);

    // Budget check
    const bidValue = Number(this.state.bidAmount);
    if (bidValue <= 0) {
      this.setState({
        error: true,
        errorMessage: "Bid amount must be greater than 0",
        transactionIsLoading: false,
      });
      return;
    }
    if (bidValue > remainingBudget) {
      this.setState({
        error: true,
        errorMessage: `Bid exceeds your remaining budget of ${remainingBudget} wei`,
        transactionIsLoading: false,
      });
      return;
    }

    // Existing validation checks
    if (val + bidValue < Number(minimumContribution)) {
      this.setState({
        error: true,
        errorMessage: "You can only contribute more than the minimum required!",
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
      await campaign.methods.contribute().send({
        from: connectedAccount,
        value: bidValue,
      });

      // Show a success toast
      toast.success("Bid placed successfully!");

      // Update spending and refresh via callback
      onSuccessfulBid(bidValue);

      // Clear the input field only on success
      this.setState({ bidAmount: "", transactionIsLoading: false });
    } catch (err) {
      toast.error("Error placing bid: " + err.message);
      this.setState({ transactionIsLoading: false, error: true, errorMessage: err.message });
    }
  };

  onReveal = (event) => {
    this.setState({ weiInfoClicked: true });
  };

  render() {
    return (
      <FormControl>
        <div className={styles.tooltip}>
          <label className={styles.tooltiplabe}>
            Minimum Bid (in Wei)
            <button onClick={this.onReveal} className={styles.circleIcon}>
              ?
            </button>
            <div className={styles.description}>
              {this.state.weiInfoClicked && (
                <div>
                  <div>
                    <Typography fontStyle="italic">
                      Wei is the smallest (base) unit of Ether, you can convert
                      between Ether units
                      <a href="https://eth-converter.com/"> here.</a>
                    </Typography>
                  </div>
                </div>
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