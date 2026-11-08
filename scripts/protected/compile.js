const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const root = path.resolve(__dirname, "../..");

function compileContracts({ includeLegacy = false, extraSources = {} } = {}) {
  const names = ["ProtectedCampaign.sol", ...(includeLegacy ? ["Campaign.sol"] : [])];
  const sources = Object.fromEntries(names.map((name) => [name, {
    content: fs.readFileSync(path.join(root, "src/real_ethereum/contracts", name), "utf8"),
  }]));
  Object.assign(sources, extraSources);
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } },
    },
  })));
  const errors = (result.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  return result.contracts;
}

function writeArtifacts() {
  const contracts = compileContracts()["ProtectedCampaign.sol"];
  const directory = path.join(root, "src/real_ethereum/build");
  fs.mkdirSync(directory, { recursive: true });
  // Do not remove this directory: legacy contracts are still used for history.
  for (const name of ["ProtectedCampaign", "ProtectedCampaignFactory"]) {
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(contracts[name], null, 2));
  }
  return contracts;
}

if (require.main === module) {
  console.log(`Compiled ${Object.keys(writeArtifacts()).join(", ")} using ${solc.version()}`);
}

module.exports = { compileContracts, writeArtifacts };
