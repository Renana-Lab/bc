"use strict";
// Generate N random participant codes and add their digests to the faucet allowlist table.
//   node scripts/faucet/generatePids.js --count 50 --table bc-faucet-FaucetTable-XXXX --region us-east-1 \
//        --base-url https://datamarketplaces.net --out faucet-pids-batch1.csv
//   add --dry-run to only generate the file (no AWS call).
// The CSV (codes + participant links) is the ONLY place raw codes exist: keep it private, hand the links
// out of band, and do not commit it (faucet-pids-*.csv is git-ignored).
const fs = require("fs");
const path = require("path");
const { generatePids, uploadPids } = require("./pidTools");

const args = process.argv.slice(2);
const read = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const count = Number(read("--count", "0"));
const table = read("--table");
const region = read("--region", process.env.AWS_REGION || "us-east-1");
const baseUrl = read("--base-url", "http://localhost:3000").replace(/\/$/, "");
const out = read("--out", `faucet-pids-${Date.now()}.csv`);
const dryRun = args.includes("--dry-run");

if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error("--count must be 1..5000");
if (!dryRun && !table) throw new Error("--table is required (or use --dry-run)");
if (!path.basename(out).startsWith("faucet-pids-")) throw new Error("--out must be named faucet-pids-*.csv so it stays git-ignored");
if (fs.existsSync(out)) throw new Error(`${out} already exists; choose a new file name`);

(async () => {
  const pids = generatePids(count);
  if (!dryRun) {
    const { createDynamoStore } = require("../../infrastructure/faucet/store");
    const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
    const created = await uploadPids(createDynamoStore({ table, client: new DynamoDBClient({ region }) }), pids);
    if (created !== pids.length) throw new Error(`Only ${created} of ${pids.length} codes were new; nothing written to ${out}`);
  }
  fs.writeFileSync(out, ["pid,link", ...pids.map((pid) => `${pid},${baseUrl}/?pid=${pid}`)].join("\n") + "\n", { flag: "wx" });
  console.log(`${dryRun ? "[dry run] " : ""}${pids.length} codes written to ${out}${dryRun ? " (not uploaded)" : " and uploaded as digests"}.`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
