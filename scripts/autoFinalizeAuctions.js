const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const Web3 = require("web3");
const campaignJson = require("../src/real_ethereum/build/Campaign.json");
const factoryJson = require("../src/real_ethereum/build/CampaignFactory.json");

const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const factoryAddressPath = path.resolve(__dirname, "../src/real_ethereum/factoryAddress.js");

function loadFactoryAddress() {
  const factoryAddressSource = require("fs").readFileSync(factoryAddressPath, "utf8");
  const match = factoryAddressSource.match(/0x[a-fA-F0-9]{40}/);

  if (!match) {
    throw new Error(`Could not find factory address in ${factoryAddressPath}`);
  }

  return match[0];
}

const RPC_URL =
  process.env.RPC_URL ||
  (process.env.INFURA_KEY ? `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}` : DEFAULT_RPC_URL);
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.AUTO_FINALIZE_PRIVATE_KEY;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || loadFactoryAddress();
const INTERVAL_MS = Number(process.env.AUTO_FINALIZE_INTERVAL_MS || 15000);
const CONCURRENCY = Number(process.env.AUTO_FINALIZE_CONCURRENCY || 4);
const REFUND_BATCH_SIZE = Number(process.env.AUTO_REFUND_BATCH_SIZE || 0);
const RUN_ONCE = process.argv.includes("--once");

if (!PRIVATE_KEY) {
  console.error(
    "Missing PRIVATE_KEY or AUTO_FINALIZE_PRIVATE_KEY in .env or GitHub Actions secrets."
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
const refundBatchUnsupported = new Set();

const isEnded = (endTime) => Number(endTime) * 1000 <= Date.now();
const isAlreadyFinalizedError = (error) => {
  const message = error?.message || String(error);
  return message.includes("Auction already finalized") || message.includes("already finalized");
};

const isMissingRefundBatchSupport = (error, includePlainRevert = false) => {
  const message = error?.message || String(error);
  return (
    message.includes("nextRefundIndex") ||
    message.includes("processRefunds") ||
    message.includes("Returned values aren't valid") ||
    (includePlainRevert && message.includes("execution reverted"))
  );
};

async function processRefundBatch(address, campaign) {
  if (!REFUND_BATCH_SIZE) return null;
  if (refundBatchUnsupported.has(address)) return null;

  try {
    let nextRefundIndex;
    try {
      nextRefundIndex = await campaign.methods.nextRefundIndex().call();
    } catch (error) {
      if (isMissingRefundBatchSupport(error, true)) {
        refundBatchUnsupported.add(address);
        return null;
      }

      throw error;
    }

    const refundAddresses = await campaign.methods.getAddresses().call();

    if (Number(nextRefundIndex) >= refundAddresses.length) return null;

    const gas = await campaign.methods
      .processRefunds(REFUND_BATCH_SIZE)
      .estimateGas({ from: account.address });
    const receipt = await campaign.methods.processRefunds(REFUND_BATCH_SIZE).send({
      from: account.address,
      gas: Math.ceil(Number(gas) * 1.2),
    });

    return receipt.transactionHash;
  } catch (error) {
    if (isMissingRefundBatchSupport(error)) {
      refundBatchUnsupported.add(address);
      return null;
    }

    console.error(`Refund batch skipped for ${address}:`, error.message || error);
    return null;
  }
}

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

      try {
        const campaign = new web3.eth.Contract(campaignJson.abi, address);
        const [summary, closed] = await Promise.all([
          campaign.methods.getSummary().call(),
          campaign.methods.getStatus().call(),
        ]);

        if (closed) {
          const refundHash = await processRefundBatch(address, campaign);
          if (!refundHash) knownClosed.add(address);
          return refundHash ? { address, refundHash } : null;
        }

        if (!isEnded(summary[9])) return null;

        inFlight.add(address);
        const gas = await campaign.methods
          .finalizeAuctionIfNeeded()
          .estimateGas({ from: account.address });
        const receipt = await campaign.methods.finalizeAuctionIfNeeded().send({
          from: account.address,
          gas: Math.ceil(Number(gas) * 1.2),
        });
        const refundHash = await processRefundBatch(address, campaign);

        return {
          address,
          hash: receipt.transactionHash,
          refundHash,
        };
      } catch (error) {
        if (isAlreadyFinalizedError(error)) {
          knownClosed.add(address);
          return null;
        }

        console.error(`Finalize skipped for ${address}:`, error.message || error);
        return null;
      } finally {
        inFlight.delete(address);
      }
    }
  );

  results.filter(Boolean).forEach((result) => {
    if (result.hash) console.log(`Finalized ${result.address}: ${result.hash}`);
    if (result.refundHash) {
      console.log(`Processed refund batch for ${result.address}: ${result.refundHash}`);
    }
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
