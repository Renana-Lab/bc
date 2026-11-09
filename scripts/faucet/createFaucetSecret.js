"use strict";
// Creates the faucet wallet and stores its private key ONLY in AWS Secrets Manager.
// The key is generated here, sent straight to Secrets Manager and never printed, written to disk,
// or kept in .env. The script prints the PUBLIC address to fund and to give the monitor.
//   node scripts/faucet/createFaucetSecret.js --name bc-faucet/key --region us-east-1
//   add --dry-run to generate and discard a key without calling AWS.
const { Wallet } = require("ethers");

const args = process.argv.slice(2);
const read = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const name = read("--name", "bc-faucet/key");
const region = read("--region", process.env.AWS_REGION || "us-east-1");
const dryRun = args.includes("--dry-run");

(async () => {
  const wallet = Wallet.createRandom();
  if (!dryRun) {
    const { SecretsManagerClient, CreateSecretCommand } = require("@aws-sdk/client-secrets-manager");
    const result = await new SecretsManagerClient({ region }).send(new CreateSecretCommand({
      Name: name,
      Description: "Protected faucet signing key (Sapphire testnet TEST tokens only)",
      SecretString: JSON.stringify({ privateKey: wallet.privateKey }),
    }));
    console.log(`Secret ARN (pass to deployFaucet.js --secret-arn): ${result.ARN}`);
  }
  console.log(`Faucet address (fund it with TEST tokens; give to --faucet-address): ${wallet.address}`);
  if (dryRun) console.log("[dry run] key discarded, nothing stored.");
})().catch((error) => {
  // Print only the error name: AWS error text could echo request details.
  console.error(`Failed: ${error?.name || "error"}`);
  process.exit(1);
});
