require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.8.28"
  },
  networks: {
    sepolia: {
      url: "https://sepolia.infura.io/v3/b27d53291ceb44bd864dbf7b0eb55581",
      accounts: ["fbf0fe464efb8b20cf9c758b96cf6f23b6f70caa34413e71e4c2363d70bdb1bd"]
    }
  },
  etherscan: {
    apiKey: "5XKKQST56T5QFV7ECKEPNICAHP578UUG58"
  }
};
