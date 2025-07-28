try {
    console.log("🔍 Initializing provider...");
const provider = new BrowserProvider(window.ethereum);

const signer = await provider.getSigner();

const token = new Contract(tokenAddress, tokenABI, signer);

const chainId = (await provider.getNetwork()).chainId;

const deadline = Math.floor(Date.now() / 1000) + 3600 * 2; // 2 hours buffer

const nonce = await token.nonces(connectedAccount);

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


const decimals = await token.decimals(); // typically 18

const tokenToETHValue = parseUnits(String(additionalBid), decimals);


const balance = await token.balanceOf(connectedAccount);

const readableBalance = formatUnits(balance, 18);

const message = {
owner: connectedAccount,
spender: campaign.options.address,
value: tokenToETHValue.toString(),  // ✅ stringified!
nonce: Number(nonce),          // convert BigInt to Number
deadline: Number(deadline),    // convert BigInt to Number
};

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



const { v, r, s } = Signature.from(signature);

const allowance = await token.allowance(connectedAccount, campaign.options.address);

const onChainNonce = await token.nonces(connectedAccount);

await campaign.methods.permitAndContribute(tokenToETHValue, deadline, v, r, s).send({ from: connectedAccount });

} catch (err) {
this.setState({
transactionIsLoading: false,
error: true,
errorMessage: err.message,
});
}
