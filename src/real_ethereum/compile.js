const path = require("path");
const solc = require("solc");
const fs = require("fs-extra");
const deploy = require("./deploy");

const buildPath = path.resolve(__dirname, "build");
fs.removeSync(buildPath);

const campaignPath = path.resolve(__dirname, "contracts", "Campaign.sol");
const source = fs.readFileSync(campaignPath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "Campaign.sol": {
      content: source,
    },
  },
  settings: {
    outputSelection: {
      "*": {
        "*": ["*"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input))).contracts[
  "Campaign.sol"
];

fs.ensureDirSync(buildPath);

for (let contract in output) {
  fs.outputJsonSync(
    path.resolve(buildPath, contract.replace(":", "") + ".json"),
    output[contract]
  );
}

// Automatically deploy and update after compilation
(async () => {
  try {
    console.log("Starting deployment after compilation...");
    await deploy();
    console.log("Deployment completed successfully!!");
  } catch (error) {
    console.error("Error during deployment:", error);
  }
})();
