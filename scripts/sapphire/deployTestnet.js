"use strict";
// Guarded wrapper for deploying CampaignFactory to Oasis Sapphire TESTNET (public network).
// It is NOT run by tests or CI. You run it yourself, after reading docs/SAPPHIRE_TESTNET_RUNBOOK.md.
//
//   $env:DEPLOY_PRIVATE_KEY = "0x..."          # PowerShell, this shell session only; never in .env
//   $env:FACTORY_SIWE_DOMAIN = "datamarketplaces.net"
//   node scripts/sapphire/deployTestnet.js --dry-run               # checks only, no network, no transaction
//   node scripts/sapphire/deployTestnet.js --confirm-public-testnet
//
// Safety checks (all must pass before anything is sent):
//  * the explicit flag --confirm-public-testnet (a dry run needs no flag and sends nothing)
//  * the deployer key comes from the process environment, NOT from .env
//  * FACTORY_SIWE_DOMAIN is set, has no scheme/path, and is not localhost (it is fixed in the contract forever)
//  * DEPLOY_NETWORK is forced to sapphire-testnet (mainnet is not supported by deploy.js)
//  * the compiled contract exists
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const confirmed = args.includes("--confirm-public-testnet");
const problems = [];

const key = process.env.DEPLOY_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) problems.push("DEPLOY_PRIVATE_KEY must be set in this shell (64 hex chars).");

const envFile = path.join(root, ".env");
if (fs.existsSync(envFile) && /^\s*(DEPLOY_PRIVATE_KEY|PRIVATE_KEY)\s*=/m.test(fs.readFileSync(envFile, "utf8"))) {
  problems.push("A deployer key is present in .env. Remove it; keep keys out of files and use the shell environment.");
}

const domain = process.env.FACTORY_SIWE_DOMAIN || "";
if (!domain) problems.push("FACTORY_SIWE_DOMAIN is required (the host users open the app on).");
else if (/^https?:\/\//i.test(domain) || domain.includes("/")) problems.push("FACTORY_SIWE_DOMAIN must be a host (and optional port) only, e.g. datamarketplaces.net");
else if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain)) problems.push("FACTORY_SIWE_DOMAIN must not be localhost for a testnet deployment.");

if (process.env.DEPLOY_RPC_URL && !/^https:\/\/([a-z0-9-]+\.)*oasis\.io(:\d+)?(\/|$)/.test(process.env.DEPLOY_RPC_URL)) {
  problems.push("DEPLOY_RPC_URL, if set, must be an https://*.oasis.io endpoint.");
}
if (!fs.existsSync(path.join(root, "src", "real_ethereum", "build", "CampaignFactory.json"))) {
  problems.push("Compiled contracts are missing. Run: npm run sapphire:compile");
}
if (!dryRun && !confirmed) problems.push("Add --confirm-public-testnet to send transactions to the public Sapphire Testnet.");

if (problems.length) {
  console.error("Not deploying:\n - " + problems.join("\n - "));
  process.exit(1);
}
if (dryRun) {
  console.log("[dry run] all checks passed. Nothing was sent. Domain:", domain, "| network: sapphire-testnet (chain 23295)");
  process.exit(0);
}

const result = spawnSync(process.execPath, [path.join(root, "src", "real_ethereum", "deploy.js")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, DEPLOY_NETWORK: "sapphire-testnet", DEPLOY_MARKET: process.env.DEPLOY_MARKET || "real" },
});
if (result.status === 0) {
  console.log("\nNext: set these in AWS Amplify (see the runbook), then redeploy the site:");
  console.log("  REACT_APP_NETWORK=sapphire-testnet");
  console.log("  REACT_APP_FACTORY_ADDRESS=<address printed above>");
  console.log("  REACT_APP_WALLET_MODE=local");
}
process.exit(result.status ?? 1);
