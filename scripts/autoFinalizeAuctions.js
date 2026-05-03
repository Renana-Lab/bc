const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const Web3 = require("web3");
const campaignJson = require("../src/real_ethereum/build/Campaign.json");
const factoryJson = require("../src/real_ethereum/build/CampaignFactory.json");

const RPC_URL = process.env.RPC_URL || `https://sepolia.infura.io/v3/${process.env.INFURA_KEY || ""}`;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const INTERVAL_MS = Number(process.env.AUTO_FINALIZE_INTERVAL_MS || 15000);
const CONCURRENCY = Number(process.env.AUTO_FINALIZE_CONCURRENCY || 4);
const RUN_ONCE = process.argv.includes("--once");

if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS) {
  console.error(
    "Missing RPC_URL or INFURA_KEY, PRIVATE_KEY, and FACTORY_ADDRESS in .env."
  );
  process.exit(1);
}

const web3 = new Web3(RPC_URL);
const account = web3.eth.accounts.privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`
);
web3.eth.accounts.wallet.add(account);
web3.eth.defaultAccount = account.address;

const factory = new web3.eth.Contract(factoryJson.abi, FACTORY_ADDRESS);
const inFlight = new Set();
const knownClosed = new Set();

const isEnded = (endTime) => Number(endTime) * 1000 <= Date.now();

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

async function finalizeReadyAuctions() {
  const addresses = await factory.methods.getDeployedCampaigns().call();
  const candidates = addresses.filter((address) => !knownClosed.has(address));

  const results = await mapWithConcurrency(
    candidates,
    CONCURRENCY,
    async (address) => {
      if (inFlight.has(address)) return null;

      const campaign = new web3.eth.Contract(campaignJson.abi, address);
      const [summary, closed] = await Promise.all([
        campaign.methods.getSummary().call(),
        campaign.methods.getStatus().call(),
      ]);

      if (closed) {
        knownClosed.add(address);
        return null;
      }

      if (!isEnded(summary[9])) return null;

      inFlight.add(address);
      try {
        const gas = await campaign.methods
          .finalizeAuctionIfNeeded()
          .estimateGas({ from: account.address });
        const receipt = await campaign.methods.finalizeAuctionIfNeeded().send({
          from: account.address,
          gas: Math.ceil(Number(gas) * 1.2),
        });

        return {
          address,
          hash: receipt.transactionHash,
        };
      } finally {
        inFlight.delete(address);
      }
    }
  );

  results.filter(Boolean).forEach((result) => {
    console.log(`Finalized ${result.address}: ${result.hash}`);
  });
}

async function main() {
  console.log(`Auto-finalizer running from ${account.address}`);

  await finalizeReadyAuctions();
  if (RUN_ONCE) return;

  setInterval(() => {
    finalizeReadyAuctions().catch((error) => {
      console.error("Auto-finalizer cycle failed:", error.message || error);
    });
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error("Auto-finalizer failed:", error);
  process.exit(1);
});
