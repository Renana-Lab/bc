import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import HDWalletProvider from "@truffle/hdwallet-provider";
import Web3 from "web3";
import dotenv from "dotenv";
dotenv.config();

// ⚙️ נתיב לתיקייה הנוכחית
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 🔽 טען את הקבצים המקמפלים
const compiledToken = JSON.parse(
  fs.readFileSync(
    new URL("../../artifacts/contracts/MyToken.sol/MyToken.json", import.meta.url),
    "utf8"
  )
);

const compiledFactory = JSON.parse(
  fs.readFileSync(
    new URL("./build/CampaignFactory.json", import.meta.url),
    "utf8"
  )
);

// 🧠 קח את ה-bytecode בפורמט המתאים
const bytecodeFactory =
  compiledFactory.evm?.bytecode?.object || compiledFactory.bytecode;

if (!bytecodeFactory) {
  throw new Error("❌ Missing bytecode in CampaignFactory JSON file.");
}

// 🧪 ספק + חשבונות


const mnemonic = process.env.MNEMONIC;
const infuraUrl = process.env.INFURA_URL;

// Check both exist
if (!mnemonic || !infuraUrl) {
  console.log("MNEMONIC:", process.env.MNEMONIC);
console.log("INFURA_URL:", process.env.INFURA_URL);

  throw new Error("Missing MNEMONIC or INFURA_URL from .env");
}
const provider = new HDWalletProvider(mnemonic, infuraUrl);
const web3 = new Web3(provider);

const deploy = async () => {
  try {
    const accounts = await web3.eth.getAccounts();
    const deployer = accounts[0];
    console.log("📨 Accounts:", accounts);
    console.log("🔑 Deploying from account:", deployer);

    // ✅ שלב 1: פריסת הטוקן
    console.log("🚀 Estimating gas for MyToken...");
    const tokenContract = new web3.eth.Contract(compiledToken.abi);
    const gasEstimateToken = await tokenContract
      .deploy({ data: compiledToken.bytecode, arguments: [deployer] })
      .estimateGas();

    console.log("📦 Deploying MyToken...");
    const resultToken = await tokenContract
      .deploy({ data: compiledToken.bytecode, arguments: [deployer] })
      .send({ gas: gasEstimateToken + 50000, from: deployer });

    const tokenAddress = resultToken.options.address;
    console.log("✅ Token deployed at:", tokenAddress);

    // ✅ שלב 2: פריסת הפקטורי
    console.log("🚀 Estimating gas for CampaignFactory...");
    const gasEstimateFactory = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: bytecodeFactory })
      .estimateGas();

    console.log("📦 Deploying CampaignFactory...");
    const resultFactory = await new web3.eth.Contract(compiledFactory.abi)
      .deploy({ data: bytecodeFactory })
      .send({ gas: gasEstimateFactory + 50000, from: deployer });

    const factoryAddress = resultFactory.options.address;
    console.log("✅ Factory deployed at:", factoryAddress);

    // ✏️ עדכון factory.js
    const factoryPath = path.resolve(__dirname, "factory.js");
    let factoryContent = fs.readFileSync(factoryPath, "utf8");
    factoryContent = factoryContent.replace(
      /"0x[a-fA-F0-9]{40}"/,
      `"${factoryAddress}"`
    );
    fs.writeFileSync(factoryPath, factoryContent, "utf8");
    console.log("📝 factory.js updated with factory address.");

    // ✏️ יצירת tokenAddress.js
    const tokenAddressJsPath = path.resolve(__dirname, "tokenAddress.js");
    fs.writeFileSync(tokenAddressJsPath, `export default "${tokenAddress}";\n`, "utf8");
    console.log("📝 tokenAddress.js created with token address.");
  } catch (error) {
    console.error("❌ Deployment failed:", error);
  } finally {
    provider.engine.stop();
  }
};

deploy();
