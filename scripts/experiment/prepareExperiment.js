/* eslint-env node */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const Web3Package = require("web3");
const Web3 = Web3Package.Web3 || Web3Package;
const factoryArtifact = require("../../src/real_ethereum/build/CampaignFactory.json");
const { loadFactoryAddress } = require("../factoryAddressLoader");

const ROOT = path.resolve(__dirname, "../..");
const PRIVATE_DIR = path.join(ROOT, "experiment-data", "private");
const PUBLIC_DIR = path.join(ROOT, "experiment-data", "public");
const DEFAULT_RPC_URLS = [
  "https://sepolia.gateway.tenderly.co",
  "https://sepolia.rpc.thirdweb.com",
  "https://ethereum-sepolia-rpc.publicnode.com",
];

const getArg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
};

const getRpcUrls = () => {
  const infuraKey = String(process.env.INFURA_KEY || process.env.REACT_APP_INFURA_KEY || "").trim();
  const configured = [
    ...String(process.env.RPC_URLS || process.env.REACT_APP_RPC_URLS || "").split(","),
    process.env.RPC_URL,
    process.env.REACT_APP_RPC_URL,
    infuraKey ? `https://sepolia.infura.io/v3/${infuraKey}` : "",
    ...DEFAULT_RPC_URLS,
  ].map((url) => String(url || "").trim()).filter(Boolean);
  return [...new Set(configured)];
};

const withProvider = async (operation) => {
  const failures = [];
  for (const url of getRpcUrls()) {
    const web3 = new Web3(new Web3.providers.HttpProvider(url, { timeout: 12_000 }));
    try {
      const chainId = Number(await web3.eth.getChainId());
      if (chainId !== 11155111) throw new Error(`Wrong chain ${chainId}`);
      return await operation(web3, url);
    } catch (error) {
      failures.push(`${new URL(url).hostname}: ${error.message}`);
    }
  }
  throw new Error(`No healthy Sepolia RPC endpoint. ${failures.join(" | ")}`);
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index], index);
    }
  }));
  return result;
};

const main = async () => {
  const inputPath = path.resolve(getArg("wallets") || "");
  if (!getArg("wallets") || !fs.existsSync(inputPath)) {
    throw new Error("Use --wallets <path-to-wallet-table>.");
  }
  const core = await import(path.join(ROOT, "src", "experiment", "experimentCore.mjs"));
  const rows = core.parseWalletTable(fs.readFileSync(inputPath, "utf8"));
  const experimentId = getArg("id") || core.createExperimentId();
  const seed = getArg("seed") || crypto.randomBytes(16).toString("hex");
  const factoryAddress = getArg("factory") || loadFactoryAddress({ rootDir: ROOT, market: "production" });

  const checked = await withProvider(async (web3, rpcUrl) => {
    const factory = new web3.eth.Contract(factoryArtifact.abi, factoryAddress);
    const chainId = Number(await web3.eth.getChainId());
    const checks = await mapWithConcurrency(rows, 2, async (wallet) => {
      const privateKey = String(wallet.privateKey || "").trim().replace(/^0x/, "");
      if (!/^[a-fA-F0-9]{64}$/.test(privateKey)) {
        return { ...wallet, eligible: false, reasons: ["Invalid private key"] };
      }
      const normalizedPrivateKey = `0x${privateKey}`;
      const derived = web3.eth.accounts.privateKeyToAccount(normalizedPrivateKey).address;
      const reasons = [];
      if (derived.toLowerCase() !== String(wallet.address).toLowerCase()) reasons.push("Address/key mismatch");
      if (!web3.utils.isAddress(wallet.address)) reasons.push("Invalid address");
      let balanceWei = "0";
      let latestNonce = -1;
      let pendingNonce = -1;
      let budgetWei = "";
      try {
        [balanceWei, latestNonce, pendingNonce, budgetWei] = await Promise.all([
          web3.eth.getBalance(wallet.address),
          web3.eth.getTransactionCount(wallet.address, "latest"),
          web3.eth.getTransactionCount(wallet.address, "pending"),
          factory.methods.getBudget(wallet.address).call(),
        ]);
      } catch (error) {
        reasons.push(`Live preflight failed: ${error.message}`);
      }
      if (latestNonce !== pendingNonce) reasons.push("Pending nonce exists");
      if (String(budgetWei) !== String(core.REQUIRED_BUDGET_WEI)) reasons.push(`Budget is ${budgetWei || "unreadable"}, expected 2000`);
      return {
        ...wallet,
        privateKey: normalizedPrivateKey,
        derivedAddress: derived,
        chainId,
        balanceWei: String(balanceWei),
        latestNonce,
        pendingNonce,
        budgetWei: String(budgetWei),
        eligible: reasons.length === 0,
        reasons,
      };
    });
    return { checks, rpcHost: new URL(rpcUrl).hostname };
  });

  const generallyEligible = checked.checks.filter((wallet) => wallet.eligible);
  const sellerEligible = generallyEligible.filter(
    (wallet) => BigInt(wallet.balanceWei) >= core.SELLER_MIN_BALANCE_WEI,
  );
  const bidderEligible = generallyEligible.filter(
    (wallet) => BigInt(wallet.balanceWei) >= core.BIDDER_MIN_BALANCE_WEI,
  );
  if (sellerEligible.length < 10 || bidderEligible.length < 40) {
    throw new Error(
      `Insufficient eligible wallets: ${sellerEligible.length} seller-capable and ${bidderEligible.length} bidder-capable.`,
    );
  }

  const selectedSellers = sellerEligible.slice(0, 10);
  const selectedSellerNumbers = new Set(selectedSellers.map((wallet) => wallet.number));
  const selectedBidders = bidderEligible.filter((wallet) => !selectedSellerNumbers.has(wallet.number)).slice(0, 30);
  if (selectedBidders.length < 30) throw new Error("Could not isolate 30 bidder wallets from sellers.");
  const remaining = bidderEligible.filter(
    (wallet) => !selectedSellerNumbers.has(wallet.number) && !selectedBidders.some((bidder) => bidder.number === wallet.number),
  );
  const assignments = core.assignExperimentRoles(
    [...selectedSellers, ...selectedBidders, ...remaining],
    { experimentId, seed },
  );
  const isolationErrors = core.validateRoleIsolation(assignments.participants);
  if (isolationErrors.length) throw new Error(isolationErrors.join("; "));
  const manifest = core.buildExperimentManifest({
    experimentId,
    seed,
    factoryAddress,
    assignments,
  });
  const publicManifest = core.toPublicManifest(manifest);
  const privateConfig = {
    ...manifest,
    preparedAtIso: new Date().toISOString(),
    preflight: {
      rpcHost: checked.rpcHost,
      eligibleWallets: generallyEligible.length,
      rejectedWallets: checked.checks.filter((wallet) => !wallet.eligible).map(({ number, address, reasons }) => ({ number, address, reasons })),
    },
    wallets: assignments.privateWallets,
  };

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const privatePath = path.join(PRIVATE_DIR, `${experimentId}.json`);
  const publicPath = path.join(PUBLIC_DIR, `${experimentId}.manifest.json`);
  fs.writeFileSync(privatePath, `${JSON.stringify(privateConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(publicPath, `${JSON.stringify(publicManifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    experimentId,
    factoryAddress,
    publicManifest: publicPath,
    privateConfig: privatePath,
    eligibleWallets: generallyEligible.length,
    rejectedWallets: privateConfig.preflight.rejectedWallets.length,
  }, null, 2));
};

main().catch((error) => {
  console.error(`Experiment preparation failed: ${error.message}`);
  process.exitCode = 1;
});
