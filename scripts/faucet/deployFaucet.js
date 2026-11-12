"use strict";
// Deploys the protected faucet stack (Lambda + DynamoDB + balance alarm) with CloudFormation.
// Modeled on scripts/deployLivePresence.js. NOT run automatically: see infrastructure/faucet/README.md.
//
//   node scripts/faucet/deployFaucet.js --dry-run                      builds the bundles and template locally, no AWS calls
//   node scripts/faucet/deployFaucet.js --region us-east-1 --artifact-bucket my-bucket \
//        --secret-arn arn:aws:secretsmanager:... --admin-secret-arn arn:aws:secretsmanager:... --faucet-address 0x... --alert-email ops@example.org
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");
const { buildTemplate } = require("../../infrastructure/faucet/template");

const root = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const read = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dryRun = args.includes("--dry-run");

const environment = read("--env", "");
if (environment !== "test") throw new Error("--env test is required. Only the test environment is prepared; stacks are prefixed test- and are separate from production.");
const stackName = read("--stack", "test-bc-faucet");
if (!stackName.startsWith("test-")) throw new Error("Stack names for the test environment must start with test-");
const region = read("--region", process.env.AWS_REGION || "us-east-1");
const profile = read("--profile", process.env.AWS_PROFILE || "");
const artifactBucket = read("--artifact-bucket");
const secretArn = read("--secret-arn");
const faucetAddress = read("--faucet-address");
const alertEmail = read("--alert-email");
const rpcUrl = read("--rpc-url", "https://testnet.sapphire.oasis.io");
const chainId = Number(read("--chain-id", "23295"));
const amountWei = read("--amount-wei", "1500000000000000000"); // 1.5 TEST
const lowBalance = Number(read("--low-balance", "5")); // alarm when the faucet holds fewer than this many TEST
// CORS origins: the TEST Amplify app domain (never the production domain). Localhost is allowed for local testing.
const origins = read("--origins", "http://localhost:3000");
if (/datamarketplaces\.net/.test(origins)) throw new Error("The test environment must not allow the production domain in --origins");
const rateLimit = read("--rate-limit", "20");
const pidMode = read("--pid-mode", "allowlist");
const maxPayouts = read("--max-payouts");
const requiredStudyId = read("--required-study-id");
const adminSecretArn = read("--admin-secret-arn");
// Static shared experiment string. Read from the environment (not argv) so it stays out of shell history.
const experimentCode = process.env.FAUCET_EXPERIMENT_CODE || "";
const reservedConcurrency = Number(read("--reserved-concurrency", "1"));

if (chainId !== 23295 && chainId !== 23293) throw new Error("--chain-id must be 23295 (Sapphire testnet) or 23293 (localnet); mainnet is refused");
if (!/^\d+$/.test(amountWei) || BigInt(amountWei) <= 0n) throw new Error("--amount-wei must be a positive integer");
if (!["allowlist", "prolific", "open"].includes(pidMode)) throw new Error("--pid-mode must be allowlist, prolific or open");
if (pidMode !== "allowlist" && !/^[1-9][0-9]{0,9}$/.test(maxPayouts)) throw new Error(`--max-payouts (positive integer) is required with --pid-mode ${pidMode}`);
if (pidMode === "allowlist" && (maxPayouts || requiredStudyId || experimentCode)) throw new Error("--max-payouts, --required-study-id and FAUCET_EXPERIMENT_CODE only apply with --pid-mode prolific or open");
if (pidMode === "open") console.error("WARNING: --pid-mode open does not verify identity. Any pid of 1-128 printable ASCII characters can claim once; only --max-payouts, the rate limits and the admin open/closed switch limit the spend.");
if (requiredStudyId && !/^[A-Za-z0-9_-]{1,64}$/.test(requiredStudyId)) throw new Error("--required-study-id has an unexpected format");
if (experimentCode && !/^[A-Za-z0-9_.~-]{1,64}$/.test(experimentCode)) throw new Error("FAUCET_EXPERIMENT_CODE must match [A-Za-z0-9_.~-]{1,64} (the same characters the app accepts in ?exp=)");
if (!dryRun) {
  if (!/^arn:aws[a-z-]*:secretsmanager:/.test(adminSecretArn)) throw new Error("--admin-secret-arn is required (store the output of scripts/faucet/setAdminPassword.js in Secrets Manager first)");
  if (!artifactBucket) throw new Error("--artifact-bucket is required (S3 bucket for the Lambda packages)");
  if (!/^arn:aws[a-z-]*:secretsmanager:/.test(secretArn)) throw new Error("--secret-arn is required (run scripts/faucet/createFaucetSecret.js first)");
  if (!/^0x[0-9a-fA-F]{40}$/.test(faucetAddress)) throw new Error("--faucet-address must be the public faucet address");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "bc-faucet-"));
const bundle = (entry, name) => {
  const outdir = path.join(work, name);
  esbuild.buildSync({
    entryPoints: [path.join(root, "infrastructure", "faucet", entry)],
    outfile: path.join(outdir, "index.js"),
    bundle: true, platform: "node", target: "node20", format: "cjs", minify: false,
    external: ["@aws-sdk/*"], // provided by the nodejs20.x runtime
  });
  return outdir;
};
bundle("handler.js", "faucet");
bundle("monitor.js", "monitor");

const template = buildTemplate({
  origins, alertEmail, secretArn, faucetAddress, rpcUrl, chainId, amountWei, lowBalance, rateLimit, reservedConcurrency,
  pidMode, maxPayouts, requiredStudyId, adminSecretArn,
  faucetCodeDir: path.join(work, "faucet"), monitorCodeDir: path.join(work, "monitor"),
});

const templatePath = path.join(work, "template.json");
fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));

if (dryRun) {
  console.log(`[dry run] bundles and template written to ${work} (no AWS calls were made).`);
  console.log(`[dry run] resources: ${Object.keys(template.Resources).join(", ")}`);
  process.exit(0);
}

const awsExecutable = process.env.AWS_CLI_PATH || (process.platform === "win32" ? "aws.exe" : "aws");
const runAws = (commandArgs, capture = false) => {
  const withProfile = profile ? [...commandArgs, "--profile", profile] : commandArgs;
  const result = spawnSync(awsExecutable, withProfile, { cwd: work, encoding: "utf8", stdio: capture ? "pipe" : "inherit", shell: false });
  if (result.error) throw new Error(`Could not start the AWS CLI: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`AWS command failed: aws ${commandArgs.slice(0, 2).join(" ")}`);
  return String(result.stdout || "").trim();
};

try {
  const packaged = path.join(work, "packaged.json");
  runAws(["cloudformation", "package", "--template-file", templatePath, "--s3-bucket", artifactBucket, "--output-template-file", packaged, "--region", region]);
  runAws([
    "cloudformation", "deploy", "--template-file", packaged, "--stack-name", stackName, "--region", region,
    "--capabilities", "CAPABILITY_IAM", "--parameter-overrides", `AllowedOrigins=${origins}`, `ExperimentCode=${experimentCode}`, "--tags", "Environment=test", "Project=bc-data-market", "--no-fail-on-empty-changeset",
  ]);
  const output = (key) => runAws(["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region,
    "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, "--output", "text"], true);
  console.log("\nFaucet deployed.");
  console.log(`REACT_APP_FAUCET_URL=${output("FaucetApiUrl").replace(/\/$/, "")}`);
  console.log(`Table for generatePids.js: ${output("FaucetTableName")}`);
  if (alertEmail) console.log(`Confirm the SNS subscription email sent to ${alertEmail}, otherwise balance alerts are not delivered.`);
  else console.log("WARNING: no --alert-email given: the low-balance alarm has no subscriber and nobody will be notified. Subscribe to the SNS topic.");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
