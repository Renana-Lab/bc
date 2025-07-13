require("@nomicfoundation/hardhat-toolbox");
import dotenv from "dotenv";
dotenv.config();

module.exports = {
  solidity: {
    version: "0.8.28",
  },
  networks: {
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`,
      accounts: [process.env.PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API,
  },
};
