"use strict";
// Creates the seller-bot wallets and stores their private keys ONLY in AWS Secrets Manager.
// Keys are generated in this process, sent straight to Secrets Manager and never printed, written to disk or kept in .env.
// Prints the secret ARN and the PUBLIC addresses (fund them; give them to deployFaucet.js --seller-bot-addresses, in this order).
//   node scripts/faucet/createSellerBotsSecret.js --name test-bc-faucet/seller-bots --count 3 --region us-east-2
//   add --dry-run to generate and discard keys without calling AWS.
const { Wallet } = require("ethers");

const args = process.argv.slice(2);
const read = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const name = read("--name", "test-bc-faucet/seller-bots");
if (!name.startsWith("test-")) throw new Error("Secret names for the test environment must start with test-");
const region = read("--region");
const dryRun = args.includes("--dry-run");
if (!dryRun && !region) throw new Error("--region is required (no default: be explicit about the account region)");
const count = Number(read("--count", "3"));
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("--count must be an integer from 1 to 10");

(async () => {
  const wallets = Array.from({ length: count }, () => Wallet.createRandom());
  if (!dryRun) {
    const { SecretsManagerClient, CreateSecretCommand } = require("@aws-sdk/client-secrets-manager");
    const result = await new SecretsManagerClient({ region }).send(new CreateSecretCommand({
      Name: name,
      Description: "Seller bot signing keys (Sapphire testnet TEST tokens only)",
      SecretString: JSON.stringify({ bots: wallets.map((wallet, index) => ({ id: `bot-${index + 1}`, privateKey: wallet.privateKey })) }),
    }));
    console.log(`Secret ARN (pass to deployFaucet.js --seller-secret-arn): ${result.ARN}`);
  }
  wallets.forEach((wallet, index) => console.log(`bot-${index + 1}: ${wallet.address}`));
  console.log(`--seller-bot-addresses ${wallets.map((wallet) => wallet.address).join(",")}`);
  if (dryRun) console.log("[dry run] keys discarded, nothing stored.");
})().catch((error) => {
  // Print only the error name: AWS error text could echo request details.
  console.error(`Failed: ${error?.name || "error"}`);
  process.exit(1);
});
