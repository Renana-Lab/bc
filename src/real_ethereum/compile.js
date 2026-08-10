const path = require("path");
const fs = require("fs-extra");

// ייבוא גרסה מדויקת של הסולק מה-node_modules
const solc = require(path.resolve(__dirname, "../../node_modules/solc"));

const buildPath = path.resolve(__dirname, "build");
console.log("🧹 Removing old build folder...");
fs.removeSync(buildPath);

const campaignPath = path.resolve(__dirname, "contracts", "Campaign.sol");
console.log("📄 Reading Campaign.sol from:", campaignPath);
const source = fs.readFileSync(campaignPath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "Campaign.sol": {
      content: source,
    },
  },
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    evmVersion: "shanghai",
    outputSelection: {
      "*": {
        "*": ["*"],
      },
    },
  },
};

console.log("🛠 Compiling contracts...");
console.log("🧪 Using solc version:", solc.version());

const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
const compilationErrors = (compiled.errors || []).filter(
  (entry) => entry.severity === "error"
);

if (
  compilationErrors.length > 0 ||
  !compiled.contracts ||
  !compiled.contracts["Campaign.sol"]
) {
  console.error("❌ Compilation failed:", compiled.errors);
  throw new Error("Compilation failed.");
}

const output = compiled.contracts["Campaign.sol"];
console.log("✅ Contracts compiled successfully:");
console.log(Object.keys(output)); // הדפסת שמות החוזים

fs.ensureDirSync(buildPath);

for (let contractName in output) {
  const filePath = path.resolve(buildPath, `${contractName}.json`);
  fs.outputJsonSync(filePath, output[contractName]);
  console.log(`📦 Saved ${contractName}.json to build folder`);
}

console.log("✅ Compilation finished. Run deploy.js manually after this.");
