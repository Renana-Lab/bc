import { Component } from "react";
import FormControl from "@mui/material/FormControl";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Campaign from "../real_ethereum/campaign";
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
    const summary = await campaign.methods.getSummary().call();
    const minimumContribution = summary[0];
    const endTime = summary[9];
    const manager = summary[3];
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const connectedAccount = accounts[0];

    const newBid = Number(this.state.bidAmount);
    const additionalBid = newBid - userBid;

    // Basic validations
    if (newBid <= 0) {
      this.setState({
        error: true,
        errorMessage: "Bid amount must be greater than 0",
        transactionIsLoading: false,
      });
      return;
    }
    if (newBid <= userBid) {
      this.setState({
        error: true,
        errorMessage: `Your new bid must be greater than your previous bid of ${userBid} wei`,
        transactionIsLoading: false,
      });
      return;
    }
    if (additionalBid > remainingBudget) {
      this.setState({
        error: true,
        errorMessage: `Insufficient budget. You need ${additionalBid} wei, but your remaining budget is ${remainingBudget} wei.`,
        transactionIsLoading: false,
      });
      return;
    }
    if (newBid < Number(minimumContribution)) {
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
      await campaign.methods.contribute().send({
        from: connectedAccount,
        value: additionalBid.toString(),
      });

      toast.success(
        `Bid placed successfully! You were charged ${additionalBid} wei.`
      );
      onSuccessfulBid(additionalBid, address);

      this.setState({ bidAmount: "", transactionIsLoading: false });
    } catch (err) {
        let flagForOutput = true;
        const message = err?.message || "";
        if (message.includes("User denied transaction signature")) {
          flagForOutput = false;
          toast.error("You decided to cancel your bid");
        } else {
          toast.error("Error placing bid: " + message);
        }

        this.setState({
          transactionIsLoading: false,
          error: true,
          errorMessage: flagForOutput ? message : "You decided to cancel your bid",
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
            You will be charged <strong>{difference}</strong> wei (based on your
            previous bid of {userBid} wei).
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
