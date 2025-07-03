// testFinalize.js
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const Web3 = require("web3");
const campaignJson = require("../real_ethereum/build/Campaign.json");
const factoryJson = require("../real_ethereum/build/CampaignFactory.json");

const RPC_URL = `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;

if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS) {
  console.error("❌ Missing ENV variables. Check .env for INFURA_KEY, PRIVATE_KEY, FACTORY_ADDRESS.");
  process.exit(1);
}

// Initialize web3
const web3 = new Web3(RPC_URL);
const acct = web3.eth.accounts.privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY
);
web3.eth.accounts.wallet.add(acct);
web3.eth.defaultAccount = acct.address;

// Contract instances
const factory = new web3.eth.Contract(factoryJson.abi, FACTORY_ADDRESS);

// Helper to convert Wei to Ether
const getEth = (val) => web3.utils.fromWei(web3.utils.toBN(val), "ether");

(async () => {
  try {
    console.log("🚀 Creating a new Campaign from:", acct.address);
    const endTime = Math.floor(Date.now() / 1000) + 10; // 10 שניות מעכשיו
    const tx = await factory.methods
      .createCampaign(
        "100", // minimumContribution (in wei)
        "Demo Data",
        "This is a test auction for sample data",
        endTime
      )
      .send({ from: acct.address, gas: 3_000_00 });
    console.log("📤 Tx hash:", tx.transactionHash);

    const deployed = await factory.methods.getDeployedCampaigns().call();
    const campaignAddress = deployed[deployed.length - 1];
    console.log("📦 New Campaign address:", campaignAddress);

    const campaign = new web3.eth.Contract(campaignJson.abi, campaignAddress);

    // Optional: simulate bids
    // await campaign.methods.contribute().send({ from: acct.address, value: web3.utils.toWei("0.2", "ether") });

    const highestBidder = await campaign.methods.highestBidder().call();
    const manager = await campaign.methods.manager().call();
    const contributors = await campaign.methods.getAddresses().call();

    console.log("\n=== BALANCES BEFORE FINALIZATION ===");
    console.log("Manager:", getEth(await web3.eth.getBalance(manager)));
    console.log("Winner :", getEth(await web3.eth.getBalance(highestBidder)));
    for (const c of contributors) {
      if (c !== highestBidder) {
        console.log("Loser  :", getEth(await web3.eth.getBalance(c)));
      }
    }

    // Wait until endTime
    const now = Math.floor(Date.now() / 1000);
    if (now < endTime) {
      const waitMs = (endTime - now + 1) * 1000;
      console.log(`⏳ Waiting ${waitMs / 1000} seconds for auction to end...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    console.log("\n⏳ Finalizing auction...");
    const finalizeTx = await campaign.methods
      .finalizeAuctionIfNeeded()
      .send({ from: manager, gas: 300000 });
    console.log("✅ Finalized. Tx hash:", finalizeTx.transactionHash);

    console.log("\n=== BALANCES AFTER FINALIZATION ===");
    console.log("Manager:", getEth(await web3.eth.getBalance(manager)));
    console.log("Winner :", getEth(await web3.eth.getBalance(highestBidder)));
    for (const c of contributors) {
      if (c !== highestBidder) {
        console.log("Loser  :", getEth(await web3.eth.getBalance(c)));
      }
    }
  } catch (err) {
    console.error("❌ Error during testFinalize:", err);
  }
})();
