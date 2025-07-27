import { Component } from "react";
import FormControl from "@mui/material/FormControl/index.js";
import TextField from "@mui/material/TextField/index.js";
import Button from "@mui/material/Button/index.js";
import Alert from "@mui/material/Alert/index.js";
import Campaign from "../real_ethereum/campaign.js";
import tokenABI from "../real_ethereum/tokenABI.js";
import tokenAddress from "../real_ethereum/tokenAddress.js";

import { parseUnits, Contract, BrowserProvider } from "ethers";
import { Signature } from "ethers/crypto";
import { TypedDataEncoder } from "ethers";
import { formatUnits } from "ethers";





import styles from "./../styles/components.module.scss";
import CircularProgress from "@mui/material/CircularProgress/index.js";
import { Typography } from "@mui/material";
import toast from "react-hot-toast";


const DOMAIN_NAME = "Huji Coin";
const DOMAIN_VERSION = "1";



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
  console.log("🔍 Initializing provider...");
  const provider = new BrowserProvider(window.ethereum);

  console.log("🔍 Getting signer...");
  const signer = await provider.getSigner();
  console.log("✅ Signer obtained:", signer);

  console.log("🔍 Connecting to token contract:", tokenAddress);
  const token = new Contract(tokenAddress, tokenABI, signer);

  console.log("🔍 Getting chain ID...");
  const chainId = (await provider.getNetwork()).chainId;
  console.log("✅ Chain ID:", chainId);

  const deadline = Math.floor(Date.now() / 1000) + 3600 * 2; // 2 hours buffer
  console.log("⏳ Deadline (UTC):", new Date(deadline * 1000).toUTCString());
  console.log("⏳ Deadline (local):", new Date(deadline * 1000).toString());

  const nonce = await token.nonces(connectedAccount);
  console.log("🔢 Nonce:", nonce);

  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: tokenAddress,
  };
  console.log("📦 Domain:", domain);

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  console.log("📐 Types:", types);

  const decimals = await token.decimals(); // typically 18
  console.log("decimals is ", decimals);
  const tokenToETHValue = parseUnits(String(additionalBid), decimals);
  console.log("additionalBid is ", additionalBid);
  console.log("tokenToETHValue is ", tokenToETHValue);

  console.log("connectedAccount is ", connectedAccount);
  console.log("spender is ", campaign.options.address);

  const balance = await token.balanceOf(connectedAccount);
  const readableBalance = formatUnits(balance, 18);
  console.log("Token balance (formatted):", readableBalance);  // will show "10000.0"

  const message = {
    owner: connectedAccount,
    spender: campaign.options.address,
    value: tokenToETHValue.toString(),  // ✅ stringified!
    nonce: Number(nonce),          // convert BigInt to Number
    deadline: Number(deadline),    // convert BigInt to Number
  };
  console.log("✉️ Message:", message);

  console.log("✍️ Signing permit...");

const signature = await window.ethereum.request({
  method: "eth_signTypedData_v4",
  params: [
    connectedAccount,
    JSON.stringify({
      domain,
      types,
      primaryType: "Permit",
      message,
    }),
  ],
});


  console.log("🖋️ Signature:", signature);

  const { v, r, s } = Signature.from(signature);
  console.log("✅ Parsed signature:", { v, r, s });

  const allowance = await token.allowance(connectedAccount, campaign.options.address);
  console.log("🔎 Allowance after permit:", allowance.toString());

  const onChainNonce = await token.nonces(connectedAccount);
  console.log("🧾 On-chain nonce:", onChainNonce.toString());

  console.log("🚀 Sending contributeWithPermit...");
  await campaign.methods
    .permitAndContribute(tokenToETHValue, deadline, v, r, s)
    .send({ from: connectedAccount });

  console.log("✅ Transaction sent successfully");
  toast.success(`Bid placed successfully! You were charged ${additionalBid} Huji Coins.`);
  onSuccessfulBid(additionalBid, address);

  this.setState({ bidAmount: "", transactionIsLoading: false });

} catch (err) {
  console.error("❌ Error occurred:", err);
  toast.error("Error placing bid: " + err.message);
  this.setState({
    transactionIsLoading: false,
    error: true,
    errorMessage: err.message,
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
            Total Bid (in Huji Coins)
            <button onClick={this.onReveal} className={styles.circleIcon}>
              ?
            </button>
            <div className={styles.description}>
              {this.state.weiInfoClicked && (
                <Typography fontStyle="italic">
                   Huji Coin is a token used for bidding. Bids must exceed the minimum and be higher than your previous bid.

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
