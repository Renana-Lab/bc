const HDWalletProvider = require("@truffle/hdwallet-provider");
const Web3 = require("web3");
const compiledFactory = require("./build/CampaignFactory.json");

const provider = new HDWalletProvider(
  "satisfy canoe farm alone talent elder cost minor rich frame keep tomorrow",
  // remember to change this to your own phrase!
  "https://sepolia.infura.io/v3/b27d53291ceb44bd864dbf7b0eb55581"
  // remember to change this to your own endpoint!
);
const web3 = new Web3(provider);

const deploy = async () => {
  try {
    const accounts = await web3.eth.getAccounts();
  
    console.log("Attempting to deploy from account", accounts);
  
    const result = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: compiledFactory.evm.bytecode.object })
      .send({ gas: "14000000", from: accounts[0] });
  
    console.log("Contract deployed to", result.options.address);
  } catch (error) {
    console.error("Error during deployment:", error);
  } finally {
    provider.engine.stop();
  }
};
deploy();