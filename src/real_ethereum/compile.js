import path from "path";
import fs from "fs-extra"; // שים לב לשינוי מ-fs ל-fs-extra
import solc from "solc";

// 🔹 Define paths
const contractPath = path.resolve("src", "real_ethereum", "contracts", "Campaign.sol");
const buildPath = path.resolve("src", "real_ethereum", "build");

// 🔹 Read source
const source = fs.readFileSync(contractPath, "utf8");

// 🔹 Build input
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

// 🔹 Import resolver for OpenZeppelin imports
function findImports(importPath) {
  try {
    const fullPath = path.resolve("node_modules", importPath);
    return { contents: fs.readFileSync(fullPath, "utf8") };
  } catch (e) {
    return { error: "File not found: " + importPath };
  }
}

// 🔹 Compile
console.log("🛠 Compiling Campaign.sol...");
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

if (output.errors) {
  output.errors.forEach((err) => {
    console.error(err.formattedMessage);
  });
}

if (!output.contracts || !output.contracts["Campaign.sol"]) {
  throw new Error("❌ Compilation failed. No contracts found.");
}

// 🔹 Save output
fs.removeSync(buildPath);
fs.ensureDirSync(buildPath);

const compiled = output.contracts["Campaign.sol"];
for (const name in compiled) {
  const filePath = path.resolve(buildPath, `${name}.json`);
  fs.outputJsonSync(filePath, compiled[name]);
  console.log(`📦 Saved ${name}.json`);
}

console.log("✅ Compilation complete.");
export default compiled;
