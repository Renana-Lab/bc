"use strict";
// Chain adapter for the seller job: balances, nonces, receipts, and the two transactions the bots sign.
// createCampaign is signed through the Sapphire-wrapped signer so its calldata (the confidential payload) is encrypted.
// Signing never broadcasts: the job stores nonce + hash first and only then sends the raw transaction.
const { Wallet, Interface, Transaction } = require("ethers");
const { wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");
const { isCalldataEnveloped } = require("@oasisprotocol/sapphire-paratime");

// Minimal ABI (the full artifact contains the contract bytecode and would bloat the Lambda bundle).
const FACTORY_ABI = [
  "function createCampaign(uint256 minimum, string dataSell, string dataDesc, uint256 duration)",
  "event AuctionCreatedDetailed(address indexed campaignAddress, address indexed seller, uint256 minimum, uint256 endTime, string dataDescription)",
];
const CAMPAIGN_ABI = [
  "function finalizeAuctionIfNeeded()", "function manager() view returns (address)", "function endTime() view returns (uint256)", "function closed() view returns (bool)",
];
const factoryInterface = new Interface(FACTORY_ABI);
const campaignInterface = new Interface(CAMPAIGN_ABI);

const createSellerChain = ({ provider, factoryAddress, chainId }) => {
  const sign = async (key, request, { wrap }) => {
    const wallet = new Wallet(key, provider);
    const signer = wrap ? wrapEthersSigner(wallet) : wallet;
    const rawTx = await signer.signTransaction({ type: 0, chainId, ...request });
    const tx = Transaction.from(rawTx);
    return { rawTx, txHash: tx.hash, tx };
  };
  const readBool = async (to, name) => campaignInterface.decodeFunctionResult(name, await provider.call({ to, data: campaignInterface.encodeFunctionData(name) }))[0];
  return {
    addressOf: (key) => new Wallet(key).address,
    getBalance: (address) => provider.getBalance(address),
    getNonce: (address, tag = "pending") => provider.getTransactionCount(address, tag),
    getGasPrice: async () => (await provider.getFeeData()).gasPrice,
    getReceipt: (hash) => provider.getTransactionReceipt(hash),
    getTransaction: (hash) => provider.getTransaction(hash),
    sendRaw: (raw) => provider.broadcastTransaction(raw),
    async signCreate({ key, minimum, dataSell, dataDesc, duration, nonce, gasPrice, gasLimit }) {
      const data = factoryInterface.encodeFunctionData("createCampaign", [minimum, dataSell, dataDesc, duration]);
      const { rawTx, txHash, tx } = await sign(key, { to: factoryAddress, data, nonce, gasPrice, gasLimit, value: 0n }, { wrap: true });
      return { rawTx, txHash, enveloped: isCalldataEnveloped(tx.data) };
    },
    async signFinalize({ key, auction, nonce, gasPrice, gasLimit }) {
      const data = campaignInterface.encodeFunctionData("finalizeAuctionIfNeeded");
      const { rawTx, txHash } = await sign(key, { to: auction, data, nonce, gasPrice, gasLimit, value: 0n }, { wrap: false });
      return { rawTx, txHash };
    },
    // The auction address and end time from AuctionCreatedDetailed (only the factory's own events are considered).
    parseCreated(receipt) {
      for (const log of receipt.logs || []) {
        if (String(log.address).toLowerCase() !== String(factoryAddress).toLowerCase()) continue;
        try {
          const parsed = factoryInterface.parseLog(log);
          if (parsed?.name === "AuctionCreatedDetailed") return { auction: parsed.args[0], endTime: Number(parsed.args[3]) };
        } catch { /* not this event */ }
      }
      return null;
    },
    async getAuction(address) {
      return { closed: await readBool(address, "closed") };
    },
  };
};

module.exports = { createSellerChain, FACTORY_ABI, CAMPAIGN_ABI };
