import React, { Component } from "react";
import FormControl from "@mui/material/FormControl";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Campaign from "../real_ethereum/campaign";
import web3 from "../real_ethereum/web3";
// import { Router } from "../routes";
import styles from "./../styles/components.module.scss";
import CircularProgress from "@mui/material/CircularProgress";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Typography } from "@mui/material";

class ContributeForm extends Component {
  state = {
    bidAmount: "",
    errorMessage: "",
    transactionIsLoading: false,
    error: false,
    weiInfoClicked: false,
  };
  onSubmit = async (event) => {
    this.setState({ transactionIsLoading: true });
    this.setState({ error: false });
    event.preventDefault();
    const campaign = Campaign(this.props.address);
    const summary = await campaign.methods.getSummary().call();
    const minimumContribution = summary[0];
    const endTime = summary[7];
    const manager = summary[3];
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const connectedAccount = accounts[0];
    const monney = await campaign.methods.getBid(connectedAccount).call();
    let val = 0;
    val = monney;
    if (
      Number(val) + Number(this.state.bidAmount) <
      Number(minimumContribution)
    ) {
      this.setState({ error: true });
      this.setState({
        errorMessage:
          "You can only contribute more than the minimum required !",
      });
    } else if (Number(endTime + "000") < Date.now()) {
      this.setState({ error: true });
      this.setState({
        errorMessage: "You cannnot contribute to a closed auction !",
      });
    } else if (connectedAccount.toLowerCase() === manager.toLowerCase()) {
      this.setState({ error: true });
      this.setState({
        errorMessage: "You cannnot contribute to your own auction !",
      });
    }
    try {
      const accounts = await web3.eth.getAccounts();
      await campaign.methods.contribute().send({
        from: accounts[0],
        value: this.state.bidAmount,
      });
      // Router.replaceRoute(`/auction/${this.props.address}`);
    } catch (err) {}
    this.setState({ transactionIsLoading: false });
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
                    <Typography fontStyle={'italic'}>
                      Wei is the smallest (base) unit of Ether , you can convert
                      between Ether units
                      <a href="https://eth-converter.com/"> here.</a>
                    </Typography>
                  </div>
                </div>
              )}
            </div>
          </label>
        </div>
        <label>min 1000</label>
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
          <Alert severity="error">{this.state.errorMessage}</Alert>
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
