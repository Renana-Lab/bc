const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const HDWalletProvider = require("@truffle/hdwallet-provider");
const Web3 = require("web3");
const compiledFactory = require("./build/CampaignFactory.json");

const mnemonic = process.env.DEPLOY_MNEMONIC || process.env.MNEMONIC;
const rpcUrl =
  process.env.DEPLOY_RPC_URL ||
  process.env.RPC_URL ||
  (process.env.INFURA_KEY ? `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}` : "");

if (!mnemonic || !rpcUrl) {
  throw new Error("Missing DEPLOY_MNEMONIC/MNEMONIC and DEPLOY_RPC_URL/RPC_URL/INFURA_KEY in .env");
}

const provider = new HDWalletProvider({
  mnemonic: { phrase: mnemonic },
  providerOrUrl: rpcUrl,
});

const web3 = new Web3(provider);

const deploy = async () => {
  try {
    const accounts = await web3.eth.getAccounts();

    if (!accounts.length) {
      throw new Error("No accounts found! Check your Web3 provider.");
    }

    console.log("Attempting to deploy from account:", accounts[0]);

    // Estimate required gas
    const gasEstimate = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: compiledFactory.evm.bytecode.object })
      .estimateGas();

    console.log("Estimated Gas:", gasEstimate);

    // Deploy contract
    const result = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: compiledFactory.evm.bytecode.object })
      .send({ gas: gasEstimate + 50000, from: accounts[0] });

    const contractAddress = result.options.address;
    console.log("✅ Contract successfully deployed at:", contractAddress);

    // Update the shared frontend factory address with the new deployment.
    const factoryPath = path.resolve(__dirname, "factoryAddress.js");
    let factoryContent = fs.readFileSync(factoryPath, "utf8");

    factoryContent = factoryContent.replace(
      /"0x[a-fA-F0-9]{40}"/, // Match the existing address
      `"${contractAddress}"` // Replace with the new address
    );

    fs.writeFileSync(factoryPath, factoryContent, "utf8");
    console.log("✅ factoryAddress.js updated with new contract address.");
  } catch (error) {
    console.error("❌ Deployment failed:", error);
  } finally {
    provider.engine.stop();
  }
};

deploy();
