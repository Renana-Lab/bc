// Deploys CampaignFactory to a Sapphire network through the Sapphire wrapper so the
// constructor payload is encrypted. Only localnet/testnet are allowed from this script.
//
//   DEPLOY_NETWORK=sapphire-localnet DEPLOY_PRIVATE_KEY=0x... node src/real_ethereum/deploy.js
//
// Never commit keys. Set FACTORY_SIWE_DOMAIN to the app host users sign in on
// (for example "localhost:3000").
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { JsonRpcProvider, Wallet, ContractFactory } = require("ethers");
const { wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");
const compiledFactory = require("./build/CampaignFactory.json");

const NETWORKS = {
  "sapphire-localnet": { chainId: 23293, rpcUrl: "http://localhost:8545" },
  "sapphire-testnet": { chainId: 23295, rpcUrl: "https://testnet.sapphire.oasis.io" },
};

const networkId = String(process.env.DEPLOY_NETWORK || "sapphire-localnet").toLowerCase();
const network = NETWORKS[networkId];
const privateKey =
  process.env.DEPLOY_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;
const deploymentMarket = String(process.env.DEPLOY_MARKET || "dev").toLowerCase();
// Host (and port) users open the app on, e.g. "localhost:3000". Only localnet gets a default:
// a deployed host must be stated explicitly because it is fixed in the factory forever.
const siweDomain =
  process.env.FACTORY_SIWE_DOMAIN || (networkId === "sapphire-localnet" ? "localhost:3000" : "");
const rpcUrl = process.env.DEPLOY_RPC_URL || network?.rpcUrl;

if (!network) throw new Error(`DEPLOY_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`);
if (!siweDomain) throw new Error("Set FACTORY_SIWE_DOMAIN to the host users open the app on (no default outside localnet)");
if (!privateKey) throw new Error("Set DEPLOY_PRIVATE_KEY (or PRIVATE_KEY) in .env");
if (!["dev", "real"].includes(deploymentMarket)) {
  throw new Error("DEPLOY_MARKET must be either dev or real");
}

const updateEnvFactoryAddress = (contractAddress) => {
  const envPath = path.resolve(__dirname, "../../.env");
  const envKey =
    deploymentMarket === "real"
      ? "REACT_APP_REAL_FACTORY_ADDRESS"
      : "REACT_APP_DEV_FACTORY_ADDRESS";
  const currentEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const nextLine = `${envKey}=${contractAddress}`;
  const existingKeyPattern = new RegExp(`^${envKey}=.*$`, "m");
  const nextEnv = existingKeyPattern.test(currentEnv)
    ? currentEnv.replace(existingKeyPattern, nextLine)
    : `${currentEnv.trimEnd()}${currentEnv ? "\n" : ""}${nextLine}\n`;
  fs.writeFileSync(envPath, nextEnv, "utf8");
  return envKey;
};

const deploy = async () => {
  const provider = new JsonRpcProvider(rpcUrl, network.chainId, { staticNetwork: true });
  const signer = wrapEthersSigner(
    new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, provider)
  );
  console.log("Deploying from:", await signer.getAddress(), "to", networkId);

  const factory = new ContractFactory(
    compiledFactory.abi,
    `0x${compiledFactory.evm.bytecode.object}`,
    signer
  );
  const contract = await factory.deploy(siweDomain);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  console.log("CampaignFactory deployed at:", contractAddress);

  const envKey = updateEnvFactoryAddress(contractAddress);
  console.log(`${envKey} updated in .env for the ${deploymentMarket} market.`);
};

deploy().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
