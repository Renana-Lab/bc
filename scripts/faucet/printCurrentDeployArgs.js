"use strict";
// READ-ONLY. Prints the deployFaucet.js flags that reproduce the live stack, so a redeploy (for example to add the
// seller bots) does not silently change origins, pid mode, payout caps or rate limits.
// Calls only cloudformation describe-stacks and lambda get-function-configuration. Never prints the experiment code:
// it only says whether one is set. Keep the output private (it names secret ARNs and addresses).
//   node scripts/faucet/printCurrentDeployArgs.js --stack test-bc-faucet --region us-east-2
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const read = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const stack = read("--stack", "test-bc-faucet");
const region = read("--region");
const profile = read("--profile", process.env.AWS_PROFILE || "");
const aws = process.env.AWS_CLI_PATH || (process.platform === "win32" ? "aws.exe" : "aws");
const run = (commandArgs) => {
  const result = spawnSync(aws, [...commandArgs, "--region", region, "--output", "json", ...(profile ? ["--profile", profile] : [])], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) throw new Error(`aws ${commandArgs.slice(0, 2).join(" ")} failed`);
  return JSON.parse(result.stdout);
};

// Pure: environment variables + stack parameters -> the flags. Exported for tests.
// extra: { sellerDeployed, sellerSecretArn, sellerSchedule ("disabled" or the expression), sellerLowBalance, lowBalance, reservedConcurrency }.
const buildFlags = ({ env, parameters = {}, tags = {}, extra = {} }) => {
  const flags = [];
  const notes = [];
  const add = (flag, value) => { if (value !== undefined && value !== null && String(value) !== "") flags.push(`${flag} ${value}`); };
  const origins = parameters.AllowedOrigins || env.ALLOWED_ORIGINS;
  add("--origins", origins);
  add("--pid-mode", env.FAUCET_PID_MODE);
  add("--max-payouts", env.FAUCET_MAX_PAYOUTS);
  add("--required-study-id", env.FAUCET_REQUIRED_STUDY_ID);
  add("--rate-limit", env.RATE_LIMIT_PER_WINDOW);
  add("--global-rate-limit", env.GLOBAL_RATE_LIMIT_PER_WINDOW);
  add("--faucet-address", env.FAUCET_ADDRESS);
  add("--factory-address", parameters.FactoryAddress || env.FACTORY_ADDRESS);
  add("--secret-arn", env.FAUCET_SECRET_ID);
  add("--admin-secret-arn", env.FAUCET_ADMIN_SECRET_ID);
  add("--rpc-url", env.RPC_URL);
  add("--chain-id", env.CHAIN_ID);
  add("--amount-wei", env.FAUCET_AMOUNT_WEI);
  add("--low-balance", extra.lowBalance);
  if (extra.reservedConcurrency !== undefined) add("--reserved-concurrency", extra.reservedConcurrency);
  if (extra.sellerDeployed) {
    add("--seller-secret-arn", extra.sellerSecretArn);
    add("--seller-bot-addresses", env.SELLER_BOT_ADDRESSES);
    add("--seller-funding-max-wei", env.SELLER_FUNDING_MAX_WEI);
    add("--seller-schedule", extra.sellerSchedule ? `"${extra.sellerSchedule}"` : "");
    add("--seller-low-balance", extra.sellerLowBalance);
    notes.push("Seller bots are deployed: omit these flags only if you want to REMOVE them.");
  }
  if (env.SWEEP_IDLE_MINUTES) notes.push(`SWEEP_IDLE_MINUTES=${env.SWEEP_IDLE_MINUTES} (environment variable of deployFaucet.js, not a flag)`);
  if (env.SWEEP_ADDRESS) notes.push(`SWEEP_ADDRESS=${env.SWEEP_ADDRESS} (environment variable of deployFaucet.js, not a flag)`);
  // The experiment code is a secret: only report whether one is set. Redeploys need FAUCET_EXPERIMENT_CODE in the environment.
  const experimentSet = Boolean(env.FAUCET_EXPERIMENT_CODE); // (NoEcho stack parameters are masked, the function setting is the reliable source)
  return { flags, notes, experimentSet, alertEmail: tags.alertEmail || "", sellerDeployed: Boolean(extra.sellerDeployed) };
};

if (require.main === module) {
  try {
    if (!region) throw new Error("--region is required");
    const described = run(["cloudformation", "describe-stacks", "--stack-name", stack]).Stacks[0];
    const parameters = Object.fromEntries((described.Parameters || []).map((entry) => [entry.ParameterKey, entry.ParameterValue]));
    const resources = run(["cloudformation", "describe-stack-resources", "--stack-name", stack]).StackResources;
    const faucetFunction = resources.find((resource) => resource.LogicalResourceId === "FaucetFunction")?.PhysicalResourceId;
    if (!faucetFunction) throw new Error("FaucetFunction not found in the stack");
    const env = run(["lambda", "get-function-configuration", "--function-name", faucetFunction]).Environment?.Variables || {};
    // The monitor holds the public faucet address (the faucet function only has the secret ARN).
    const monitorName = resources.find((resource) => resource.LogicalResourceId === "MonitorFunction")?.PhysicalResourceId;
    if (monitorName) env.FAUCET_ADDRESS = run(["lambda", "get-function-configuration", "--function-name", monitorName]).Environment?.Variables?.FAUCET_ADDRESS;
    const topic = resources.find((resource) => resource.LogicalResourceId === "AlertTopic")?.PhysicalResourceId;
    let alertEmail = "";
    if (topic) {
      const subscriptions = run(["sns", "list-subscriptions-by-topic", "--topic-arn", topic]).Subscriptions || [];
      alertEmail = subscriptions.find((entry) => entry.Protocol === "email")?.Endpoint || "";
    }
    const physical = (id) => resources.find((resource) => resource.LogicalResourceId === id)?.PhysicalResourceId;
    const extra = {};
    const concurrency = run(["lambda", "get-function-concurrency", "--function-name", faucetFunction]).ReservedConcurrentExecutions;
    extra.reservedConcurrency = concurrency > 0 ? 1 : 0;
    const alarmThreshold = (id) => { const name = physical(id); return name ? run(["cloudwatch", "describe-alarms", "--alarm-names", name]).MetricAlarms?.[0]?.Threshold : undefined; };
    extra.lowBalance = alarmThreshold("LowBalanceAlarm");
    const sellerFunction = physical("SellerJobFunction");
    if (sellerFunction) {
      extra.sellerDeployed = true;
      extra.sellerSecretArn = run(["lambda", "get-function-configuration", "--function-name", sellerFunction]).Environment?.Variables?.SELLER_SECRET_ID;
      const rule = run(["events", "describe-rule", "--name", physical("SellerSchedule")]);
      extra.sellerSchedule = rule.State === "DISABLED" ? "disabled" : rule.ScheduleExpression;
      extra.sellerLowBalance = alarmThreshold("SellerLowBalanceAlarm");
    }
    const { flags, notes, experimentSet } = buildFlags({ env, parameters, tags: { alertEmail }, extra });
    if (alertEmail) flags.push(`--alert-email ${alertEmail}`);
    console.log(`# Flags that reproduce stack ${stack} (${region}). Keep this output private.`);
    console.log(`--env test --stack ${stack} --region ${region} \\`);
    console.log(flags.map((flag) => `  ${flag}`).join(" \\\n"));
    for (const note of notes) console.log(`# ${note}`);
    console.log(experimentSet
      ? "# FAUCET_EXPERIMENT_CODE is SET on the live stack (value not shown). Put it in the environment of the deploy command, or the redeploy removes it."
      : "# FAUCET_EXPERIMENT_CODE is not set on the live stack.");
  } catch (error) {
    console.error(`Failed: ${error?.message || "error"}`);
    process.exit(1);
  }
}

module.exports = { buildFlags };
