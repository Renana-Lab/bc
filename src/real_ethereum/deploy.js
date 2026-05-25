const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const HDWalletProvider = require("@truffle/hdwallet-provider");
const Web3 = require("web3");
const compiledFactory = require("./build/CampaignFactory.json");

const mnemonic = process.env.DEPLOY_MNEMONIC || process.env.MNEMONIC;
const privateKey =
  process.env.DEPLOY_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  process.env.AUTO_FINALIZE_PRIVATE_KEY;
const deploymentMarket = String(process.env.DEPLOY_MARKET || "dev").toLowerCase();
const rpcUrl =
  process.env.DEPLOY_RPC_URL ||
  process.env.RPC_URL ||
  (process.env.INFURA_KEY
    ? `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`
    : "");

const missingConfig = [];
if (!mnemonic && !privateKey) {
  missingConfig.push(
    "DEPLOY_PRIVATE_KEY/PRIVATE_KEY/AUTO_FINALIZE_PRIVATE_KEY or DEPLOY_MNEMONIC/MNEMONIC"
  );
}
if (!rpcUrl) {
  missingConfig.push("DEPLOY_RPC_URL/RPC_URL/INFURA_KEY");
}

if (missingConfig.length) {
  throw new Error(`Missing ${missingConfig.join(" and ")} in .env`);
}

if (!["dev", "real"].includes(deploymentMarket)) {
  throw new Error("DEPLOY_MARKET must be either dev or real");
}

const providerOptions = privateKey
  ? {
      privateKeys: [
        privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
      ],
      providerOrUrl: rpcUrl,
    }
  : {
      mnemonic: { phrase: mnemonic },
      providerOrUrl: rpcUrl,
    };

const provider = new HDWalletProvider(providerOptions);

const web3 = new Web3(provider);

const updateEnvFactoryAddress = (contractAddress) => {
  const envPath = path.resolve(__dirname, "../../.env");
  const envKey =
    deploymentMarket === "real"
      ? "REACT_APP_REAL_FACTORY_ADDRESS"
      : "REACT_APP_DEV_FACTORY_ADDRESS";
  const currentEnv = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const nextLine = `${envKey}=${contractAddress}`;
  const existingKeyPattern = new RegExp(`^${envKey}=.*$`, "m");
  const nextEnv = existingKeyPattern.test(currentEnv)
    ? currentEnv.replace(existingKeyPattern, nextLine)
    : `${currentEnv.trimEnd()}${currentEnv ? "\n" : ""}${nextLine}\n`;

  fs.writeFileSync(envPath, nextEnv, "utf8");
  return envKey;
};

const deploy = async () => {
  try {
    const accounts = await web3.eth.getAccounts();

    if (!accounts.length) {
      throw new Error("No accounts found. Check your Web3 provider.");
    }

    console.log("Attempting to deploy from account:", accounts[0]);
    console.log("Deployment market:", deploymentMarket);

    const gasEstimate = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: compiledFactory.evm.bytecode.object })
      .estimateGas();

    console.log("Estimated Gas:", gasEstimate);

    const result = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: compiledFactory.evm.bytecode.object })
      .send({ gas: gasEstimate + 50000, from: accounts[0] });

    const contractAddress = result.options.address;
    console.log("Contract successfully deployed at:", contractAddress);

    const envKey = updateEnvFactoryAddress(contractAddress);
    console.log(`${envKey} updated in .env for the ${deploymentMarket} market.`);
  } catch (error) {
    console.error("Deployment failed:", error);
  } finally {
    provider.engine.stop();
  }
};

deploy();
