const HDWalletProvider = require("@truffle/hdwallet-provider");
const Web3 = require("web3");
const compiledFactory = require("./build/CampaignFactory.json");

// ⚠️ Replace with your own mnemonic & Infura endpoint
const provider = new HDWalletProvider(
  "satisfy canoe farm alone talent elder cost minor rich frame keep tomorrow",
  "https://sepolia.infura.io/v3/b27d53291ceb44bd864dbf7b0eb55581"
);

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

    console.log(
      "✅ Contract successfully deployed at:",
      result.options.address
    );
  } catch (error) {
    console.error("❌ Deployment failed:", error);
  } finally {
    provider.engine.stop();
  }
};

deploy();