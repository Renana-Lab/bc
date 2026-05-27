const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const Web3 = require("web3");
const campaignJson = require("../src/real_ethereum/build/Campaign.json");
const factoryJson = require("../src/real_ethereum/build/CampaignFactory.json");
const { loadFactoryAddresses } = require("./factoryAddressLoader");

const DEFAULT_RPC_URLS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
];
const RPC_URLS = [
  ...(process.env.RPC_URLS || process.env.REACT_APP_RPC_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  process.env.RPC_URL,
  process.env.INFURA_KEY ? `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}` : "",
  ...DEFAULT_RPC_URLS,
].filter((url, index, urls) => url && urls.indexOf(url) === index);
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.AUTO_FINALIZE_PRIVATE_KEY;
const FACTORY_ADDRESSES = loadFactoryAddresses();
const INTERVAL_MS = Number(process.env.AUTO_FINALIZE_INTERVAL_MS || 15000);
const CONCURRENCY = 1;
const REFUND_BATCH_SIZE = Number(process.env.AUTO_REFUND_BATCH_SIZE || 0);
const RUN_ONCE = process.argv.includes("--once");

if (!PRIVATE_KEY) {
  console.error(
    "Missing PRIVATE_KEY or AUTO_FINALIZE_PRIVATE_KEY in .env or GitHub Actions secrets."
  );
  process.exit(1);
}

const normalizedPrivateKey = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
const web3Clients = RPC_URLS.map((url) => {
  const web3 = new Web3(url);
  const account = web3.eth.accounts.privateKeyToAccount(normalizedPrivateKey);
  web3.eth.accounts.wallet.add(account);
  web3.eth.defaultAccount = account.address;
  return { url, web3 };
});
const account = web3Clients[0].web3.eth.accounts.privateKeyToAccount(
  normalizedPrivateKey
);

const inFlight = new Set();
const knownClosed = new Set();
const refundBatchUnsupported = new Set();
let nextRpcIndex = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getClient = (offset = 0) =>
  web3Clients[(nextRpcIndex + offset) % web3Clients.length];

const isRateLimitError = (error) => {
  const message = JSON.stringify(error?.message || error || "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("usage limit") ||
    message.includes("current plan") ||
    message.includes("higher limits")
  );
};

async function withRpcRetry(task, retries = web3Clients.length + 1) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const client = getClient(attempt);

    try {
      return await task(client.web3);
    } catch (error) {
      lastError = error;

      if (!isRateLimitError(error) || attempt === retries - 1) {
        throw error;
      }

      nextRpcIndex = (nextRpcIndex + 1) % web3Clients.length;
      await wait(1000 * (attempt + 1));
    }
  }

  throw lastError;
}

const factoryFor = (web3, factoryAddress) =>
  new web3.eth.Contract(factoryJson.abi, factoryAddress);
const campaignFor = (web3, address) => new web3.eth.Contract(campaignJson.abi, address);

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

async function processRefundBatch(address) {
  if (!REFUND_BATCH_SIZE) return null;
  if (refundBatchUnsupported.has(address)) return null;

  try {
    let nextRefundIndex;
    try {
      nextRefundIndex = await withRpcRetry((web3) =>
        campaignFor(web3, address).methods.nextRefundIndex().call()
      );
    } catch (error) {
      if (isMissingRefundBatchSupport(error, true)) {
        refundBatchUnsupported.add(address);
        return null;
      }

      throw error;
    }

    const refundAddresses = await withRpcRetry((web3) =>
      campaignFor(web3, address).methods.getAddresses().call()
    );

    if (Number(nextRefundIndex) >= refundAddresses.length) return null;

    const gas = await withRpcRetry((web3) =>
      campaignFor(web3, address)
        .methods.processRefunds(REFUND_BATCH_SIZE)
        .estimateGas({ from: account.address })
    );
    const receipt = await withRpcRetry((web3) =>
      campaignFor(web3, address).methods.processRefunds(REFUND_BATCH_SIZE).send({
        from: account.address,
        gas: Math.ceil(Number(gas) * 1.2),
      })
    );

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

async function finalizeReadyAuctions(factoryAddress) {
  const addresses = await withRpcRetry((web3) =>
    factoryFor(web3, factoryAddress).methods.getDeployedCampaigns().call()
  );
  const candidates = addresses.filter((address) => !knownClosed.has(address));

  const results = await mapWithConcurrency(
    candidates,
    CONCURRENCY,
    async (address) => {
      if (inFlight.has(address)) return null;

      try {
        const [summary, closed] = await Promise.all([
          withRpcRetry((web3) => campaignFor(web3, address).methods.getSummary().call()),
          withRpcRetry((web3) => campaignFor(web3, address).methods.getStatus().call()),
        ]);

        if (closed) {
          const refundHash = await processRefundBatch(address);
          if (!refundHash) knownClosed.add(address);
          return refundHash ? { address, refundHash } : null;
        }

        if (!isEnded(summary[9])) return null;

        inFlight.add(address);
        const gas = await withRpcRetry((web3) =>
          campaignFor(web3, address)
            .methods.finalizeAuctionIfNeeded()
            .estimateGas({ from: account.address })
        );
        const receipt = await withRpcRetry((web3) =>
          campaignFor(web3, address).methods.finalizeAuctionIfNeeded().send({
            from: account.address,
            gas: Math.ceil(Number(gas) * 1.2),
          })
        );
        const refundHash = await processRefundBatch(address);

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
  console.log(`Watching ${FACTORY_ADDRESSES.length} factory contract(s): ${FACTORY_ADDRESSES.join(", ")}`);

  for (const factoryAddress of FACTORY_ADDRESSES) {
    await finalizeReadyAuctions(factoryAddress);
  }
  if (RUN_ONCE) return;

  setInterval(() => {
    Promise.all(
      FACTORY_ADDRESSES.map((factoryAddress) => finalizeReadyAuctions(factoryAddress))
    ).catch((error) => {
      console.error("Auto-finalizer cycle failed:", error.message || error);
    });
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error("Auto-finalizer failed:", error);
  process.exit(1);
});
