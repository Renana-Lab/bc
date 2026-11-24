// Offline checks of the faucet CloudFormation template and the test-environment guards of the deploy
// scripts. Nothing here talks to AWS (every script run below is a dry run or fails before any call).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildTemplate } = require("../../infrastructure/faucet/template.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-bc-faucet/key-AbCdEf";

const template = buildTemplate({
  origins: "https://main.d123.amplifyapp.com", alertEmail: "ops@example.org", secretArn: ARN,
  faucetAddress: "0x0000000000000000000000000000000000000001", rpcUrl: "https://testnet.sapphire.oasis.io",
  chainId: 23295, amountWei: "100000000000000000", lowBalance: 5, faucetCodeDir: "/tmp/f", monitorCodeDir: "/tmp/m",
});
const statements = (role) => template.Resources[role].Properties.Policies[0].PolicyDocument.Statement;

test("the rate-limit table is separate, has a TTL, and keeps no backups", () => {
  const { FaucetTable, RateTable } = template.Resources;
  assert.equal(RateTable.Properties.TimeToLiveSpecification.AttributeName, "expiresAt");
  assert.equal(RateTable.Properties.TimeToLiveSpecification.Enabled, true);
  assert.equal(RateTable.Properties.PointInTimeRecoverySpecification, undefined, "no PITR: expired caller records must not be retained");
  assert.equal(RateTable.Properties.SSESpecification.SSEEnabled, true);
  assert.equal(FaucetTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  const env = template.Resources.FaucetFunction.Properties.Environment.Variables;
  assert.notDeepEqual(env.FAUCET_TABLE, env.RATE_TABLE);
  assert.equal(env.RATE_TTL_GRACE_SECONDS, "60");
});

test("IAM is least privilege: rate table update only, one secret, monitor has no secret access", () => {
  const faucet = statements("FaucetRole");
  const rate = faucet.find((s) => JSON.stringify(s.Resource).includes("RateTable"));
  assert.deepEqual(rate.Action, "dynamodb:UpdateItem");
  const codes = faucet.find((s) => JSON.stringify(s.Resource).includes("FaucetTable"));
  assert.deepEqual([...codes.Action].sort(), ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan", "dynamodb:UpdateItem"]);
  const secret = faucet.find((s) => s.Action === "secretsmanager:GetSecretValue");
  assert.equal(secret.Resource, ARN);
  for (const statement of faucet) assert.notEqual(statement.Resource, "*", "no wildcard resources for the faucet role");
  const monitor = statements("MonitorRole");
  assert.equal(monitor.length, 1);
  assert.equal(monitor[0].Action, "cloudwatch:PutMetricData");
  assert.deepEqual(monitor[0].Condition, { StringEquals: { "cloudwatch:namespace": "BcFaucet" } });
  assert.equal(JSON.stringify(template.Resources.MonitorFunction).includes("secretsmanager"), false);
  assert.equal(template.Resources.MonitorFunction.Properties.Environment.Variables.FAUCET_SECRET_ID, undefined);
});

test("auto-return job: EventBridge every 5 minutes, own role without secrets, same bundle, scan-only extras", () => {
  const { SweepJobFunction, SweepJobRole, SweepSchedule, SweepSchedulePermission } = template.Resources;
  assert.equal(SweepJobFunction.Properties.Handler, "index.sweepJob");
  assert.equal(SweepJobFunction.Properties.Code, template.Resources.FaucetFunction.Properties.Code, "same bundle as the faucet handler");
  assert.equal(SweepSchedule.Properties.ScheduleExpression, "rate(5 minutes)");
  assert.equal(SweepSchedulePermission.Properties.Principal, "events.amazonaws.com");
  const job = statements("SweepJobRole");
  assert.equal(job.length, 1);
  assert.deepEqual([...job[0].Action].sort(), ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:UpdateItem"]);
  assert.equal(JSON.stringify(SweepJobRole).includes("secretsmanager"), false, "the job never touches a key or the admin secret");
  assert.equal(SweepJobFunction.Properties.Environment.Variables.SWEEP_ADDRESS, "0x0000000000000000000000000000000000000001", "defaults to the faucet address");
  assert.equal(SweepJobFunction.Properties.Environment.Variables.SWEEP_IDLE_MINUTES, "30");
  assert.equal(SweepJobFunction.Properties.ReservedConcurrentExecutions, 1);
  const env = template.Resources.FaucetFunction.Properties.Environment.Variables;
  assert.equal(env.SWEEP_ADDRESS, "0x0000000000000000000000000000000000000001");
  assert.equal(env.SWEEP_RATE_LIMIT_PER_WINDOW, "600", "a whole lab shares one NAT address");
  assert.equal(env.SWEEP_GLOBAL_RATE_LIMIT_PER_WINDOW, "6000");
  const custom = buildTemplate({ origins: "x", rpcUrl: "u", chainId: 23295, amountWei: "1", lowBalance: 1, faucetCodeDir: "a", monitorCodeDir: "b", sweepAddress: "0x00000000000000000000000000000000000000aa", sweepIdleMinutes: 60 });
  assert.equal(custom.Resources.SweepJobFunction.Properties.Environment.Variables.SWEEP_ADDRESS, "0x00000000000000000000000000000000000000aa");
  assert.equal(custom.Resources.SweepJobFunction.Properties.Environment.Variables.SWEEP_IDLE_MINUTES, "60");
});

test("globalRateLimit is wired into GLOBAL_RATE_LIMIT_PER_WINDOW (default 600) next to the per-caller limit", () => {
  const make = (extra = {}) => buildTemplate({ origins: "x", rpcUrl: "u", chainId: 23295, amountWei: "1", lowBalance: 1, faucetCodeDir: "a", monitorCodeDir: "b", ...extra }).Resources.FaucetFunction.Properties.Environment.Variables;
  assert.equal(make().GLOBAL_RATE_LIMIT_PER_WINDOW, "600");
  assert.equal(make().RATE_LIMIT_PER_WINDOW, "20");
  const raised = make({ rateLimit: "300", globalRateLimit: "3000" });
  assert.equal(raised.RATE_LIMIT_PER_WINDOW, "300");
  assert.equal(raised.GLOBAL_RATE_LIMIT_PER_WINDOW, "3000");
});

test("network, alarm and exposure settings", () => {
  const env = template.Resources.FaucetFunction.Properties.Environment.Variables;
  assert.equal(env.CHAIN_ID, "23295");
  assert.equal(template.Resources.FaucetFunction.Properties.ReservedConcurrentExecutions, 1);
  assert.equal(template.Resources.LowBalanceAlarm.Properties.TreatMissingData, "breaching");
  assert.equal(template.Resources.LowBalanceAlarm.Properties.Threshold, 5);
  assert.ok(template.Resources.FaucetUrl.Properties.Cors.AllowHeaders.includes("x-admin-password"), "browser admin calls may send the password header");
  assert.ok(template.Resources.FaucetUrl.Properties.Cors.AllowHeaders.includes("x-admin-proof"), "browser admin calls may send the wallet proof header");
  assert.ok(template.Resources.FaucetUrl.Properties.Cors.AllowHeaders.includes("content-type"));
  assert.deepEqual(env.FACTORY_ADDRESS, { Ref: "FactoryAddress" });
  assert.deepEqual(template.Parameters.FactoryAddress, { Type: "String", Default: "", AllowedPattern: "^(0x[0-9a-fA-F]{40})?$" }, "empty by default = wallet auth disabled");
  assert.deepEqual(env.ALLOWED_ORIGINS, { "Fn::Join": [",", { Ref: "AllowedOrigins" }] });
  const withFactory = buildTemplate({ origins: "x", rpcUrl: "u", chainId: 23295, amountWei: "1", lowBalance: 1, factoryAddress: "0xf6d6e74e113CE7107b8a7edB7427927e51e3A146", faucetCodeDir: "a", monitorCodeDir: "b" });
  assert.equal(withFactory.Parameters.FactoryAddress.Default, "0xf6d6e74e113CE7107b8a7edB7427927e51e3A146");
  assert.deepEqual(template.Resources.FaucetUrl.Properties.Cors.AllowMethods, ["GET", "POST"]); // GET /status, POST /claim and /admin/state
  const json = JSON.stringify(template);
  assert.equal(/datamarketplaces\.net/.test(json), false, "no production domain");
  assert.equal(/0x[0-9a-fA-F]{64}\b/.test(json), false, "no key-like values");
  const noConcurrency = buildTemplate({ origins: "x", rpcUrl: "u", chainId: 23295, amountWei: "1", lowBalance: 1, reservedConcurrency: 0, faucetCodeDir: "a", monitorCodeDir: "b" });
  assert.equal(noConcurrency.Resources.FaucetFunction.Properties.ReservedConcurrentExecutions, undefined);
});

const run = (script, args) => spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: "utf8", env: { ...process.env, AWS_PROFILE: "" } });

test("deploy and secret scripts are test-environment only and refuse prod-looking inputs before any AWS call", () => {
  assert.notEqual(run("deployFaucet.js", ["--dry-run"]).status, 0, "--env test is required");
  assert.match(run("deployFaucet.js", ["--dry-run"]).stderr, /--env test is required/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--stack", "bc-faucet", "--dry-run"]).stderr, /start with test-/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--origins", "https://datamarketplaces.net", "--dry-run"]).stderr, /production domain/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--chain-id", "23294", "--dry-run"]).stderr, /mainnet is refused/);
  assert.match(run("createFaucetSecret.js", ["--name", "bc-faucet/key", "--dry-run"]).stderr, /start with test-/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--factory-address", "0x123", "--dry-run"]).stderr, /--factory-address must be/);
  assert.equal(run("deployFaucet.js", ["--env", "test", "--factory-address", "0xf6d6e74e113CE7107b8a7edB7427927e51e3A146", "--dry-run"]).status, 0);
  const ok = run("deployFaucet.js", ["--env", "test", "--dry-run"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /no AWS calls were made/);
  const secret = run("createFaucetSecret.js", ["--dry-run"]);
  assert.equal(secret.status, 0);
  assert.match(secret.stdout, /key discarded, nothing stored/);
  assert.equal(/0x[0-9a-fA-F]{64}\b/.test(secret.stdout + secret.stderr), false, "the key is never printed");
});

test("prolific, cap, study and admin-secret settings are wired through; no secret value is in the template", () => {
  const ADMIN_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-bc-faucet/admin-XyZ123";
  const t = buildTemplate({
    origins: "x", rpcUrl: "u", chainId: 23295, amountWei: "1500000000000000000", lowBalance: 1, faucetCodeDir: "a", monitorCodeDir: "b",
    secretArn: ARN, adminSecretArn: ADMIN_ARN, pidMode: "prolific", maxPayouts: "40", requiredStudyId: "study1",
  });
  const env = t.Resources.FaucetFunction.Properties.Environment.Variables;
  assert.equal(env.FAUCET_PID_MODE, "prolific");
  assert.equal(env.FAUCET_MAX_PAYOUTS, "40");
  assert.equal(env.FAUCET_REQUIRED_STUDY_ID, "study1");
  assert.equal(env.FAUCET_ADMIN_SECRET_ID, ADMIN_ARN);
  assert.deepEqual(env.FAUCET_EXPERIMENT_CODE, { Ref: "ExperimentCode" }, "experiment code comes from a NoEcho parameter, never a literal");
  assert.equal(t.Parameters.ExperimentCode.NoEcho, true);
  assert.equal(t.Parameters.ExperimentCode.Default, "");
  const secrets = t.Resources.FaucetRole.Properties.Policies[0].PolicyDocument.Statement.filter((x) => x.Action === "secretsmanager:GetSecretValue").map((x) => x.Resource);
  assert.deepEqual(secrets.sort(), [ADMIN_ARN, ARN].sort(), "read access to exactly the key secret and the admin hash secret");
  // Defaults: allowlist mode, no cap.
  const defaults = template.Resources.FaucetFunction.Properties.Environment.Variables;
  assert.equal(defaults.FAUCET_PID_MODE, "allowlist");
  assert.equal(defaults.FAUCET_MAX_PAYOUTS, "");
});

test("deploy script: default amount is 1.5 TEST and the prolific flags are validated", () => {
  assert.match(run("deployFaucet.js", ["--env", "test", "--pid-mode", "prolific", "--dry-run"]).stderr, /--max-payouts/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--pid-mode", "weird", "--dry-run"]).stderr, /--pid-mode/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--max-payouts", "5", "--dry-run"]).stderr, /only apply with --pid-mode prolific/);
  assert.equal(run("deployFaucet.js", ["--env", "test", "--pid-mode", "prolific", "--max-payouts", "40", "--dry-run"]).status, 0);
  // open mode: the cap is required, a warning is printed
  assert.match(run("deployFaucet.js", ["--env", "test", "--pid-mode", "open", "--dry-run"]).stderr, /--max-payouts.*--pid-mode open/);
  const open = run("deployFaucet.js", ["--env", "test", "--pid-mode", "open", "--max-payouts", "40", "--dry-run"]);
  assert.equal(open.status, 0);
  assert.match(open.stderr, /does not verify identity/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--region", "us-east-1", "--artifact-bucket", "b", "--secret-arn", ARN, "--faucet-address", "0x0000000000000000000000000000000000000001"]).stderr, /--admin-secret-arn is required/);
  assert.match(readFileSync(path.join(here, "deployFaucet.js"), "utf8"), /"--amount-wei", "1500000000000000000"/);
});

test("setAdminPassword refuses non-interactive input and never echoes anything password-like", () => {
  const result = spawnSync(process.execPath, [path.join(here, "setAdminPassword.js")], { input: "hunter2-hunter2\nhunter2-hunter2\n", encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes("hunter2"), false);
  assert.equal(result.stdout, "", "no hash is printed without a terminal");
});

test("deploy script: the experiment code must use the same characters as the app's ?exp=", () => {
  const withCode = (code) => spawnSync(process.execPath, [path.join(here, "deployFaucet.js"), "--env", "test", "--pid-mode", "prolific", "--max-payouts", "3", "--dry-run"], { encoding: "utf8", env: { ...process.env, AWS_PROFILE: "", FAUCET_EXPERIMENT_CODE: code } });
  assert.equal(withCode("Exp_2026.v1~a-b").status, 0);
  for (const bad of ["has space", "a,b", "x".repeat(65), "q=1&r", "é"]) assert.match(withCode(bad).stderr, /FAUCET_EXPERIMENT_CODE must match/, bad);
});

// ---- seller bots ----
const SELLER_ARN = "arn:aws:secretsmanager:us-east-2:123456789012:secret:test-bc-faucet/seller-bots-QwErTy";
const BOT_A = "0x00000000000000000000000000000000000000a1";
const BOT_B = "0x00000000000000000000000000000000000000b2";
const baseline = JSON.parse(readFileSync(path.join(here, "fixtures", "templateBaseline.json"), "utf8"));
const baselineOptions = JSON.parse(readFileSync(path.join(here, "fixtures", "templateBaselineOptions.json"), "utf8"));
const withSeller = (extra = {}) => buildTemplate({ ...baselineOptions, sellerSecretArn: SELLER_ARN, sellerBotAddresses: `${BOT_A},${BOT_B}`, sellerCodeDir: "/tmp/s", ...extra });

test("without --seller-secret-arn the template is byte-identical to the one before seller bots existed", () => {
  const plain = buildTemplate(baselineOptions);
  assert.equal(JSON.stringify(plain, null, 2), JSON.stringify(baseline, null, 2));
  // Seller options without the secret ARN change nothing either.
  const ignored = buildTemplate({ ...baselineOptions, sellerSchedule: "rate(5 minutes)", sellerBotAddresses: BOT_A, sellerLowBalance: 2, sellerFundingMaxWei: "5", sellerCodeDir: "/tmp/s" });
  assert.equal(JSON.stringify(ignored, null, 2), JSON.stringify(baseline, null, 2));
  assert.equal(Object.keys(plain.Resources).some((name) => /Seller/.test(name)), false);
});

test("with a seller secret: own role reads only the seller secret, the faucet and sweep roles cannot", () => {
  const t = withSeller();
  const role = t.Resources.SellerJobRole.Properties.Policies[0].PolicyDocument.Statement;
  const secrets = role.filter((s) => s.Action === "secretsmanager:GetSecretValue");
  assert.deepEqual(secrets.map((s) => s.Resource), [SELLER_ARN]);
  const table = role.find((s) => JSON.stringify(s.Resource).includes("FaucetTable"));
  assert.deepEqual([...table.Action].sort(), ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan", "dynamodb:UpdateItem"]);
  assert.equal(role.length, 2);
  for (const statement of role) assert.notEqual(statement.Resource, "*");
  for (const name of ["FaucetRole", "SweepJobRole", "MonitorRole"]) assert.equal(JSON.stringify(t.Resources[name]).includes(SELLER_ARN), false, `${name} cannot read the seller secret`);
  assert.equal(JSON.stringify(t.Resources.FaucetFunction).includes(SELLER_ARN), false, "the faucet function does not even know the secret id");
  assert.equal(JSON.stringify(t.Resources.RateTable).includes("Seller"), false);
});

test("seller function: nodejs20.x, 256 MB, 120 s, one at a time, no retries, minimal env, 30 day logs", () => {
  const t = withSeller();
  const fn = t.Resources.SellerJobFunction.Properties;
  assert.equal(fn.Runtime, "nodejs20.x");
  assert.equal(fn.MemorySize, 256);
  assert.equal(fn.Timeout, 120);
  assert.equal(fn.Handler, "index.sellerJob");
  assert.equal(fn.ReservedConcurrentExecutions, 1);
  assert.equal(fn.Code, "/tmp/s");
  assert.deepEqual(Object.keys(fn.Environment.Variables).sort(), ["CHAIN_ID", "FACTORY_ADDRESS", "FAUCET_TABLE", "RPC_URL", "SELLER_SECRET_ID"]);
  assert.equal(fn.Environment.Variables.SELLER_SECRET_ID, SELLER_ARN);
  assert.equal(t.Resources.SellerJobEventInvokeConfig.Properties.MaximumRetryAttempts, 0);
  assert.deepEqual(t.Resources.SellerJobEventInvokeConfig.Properties.FunctionName, { Ref: "SellerJobFunction" });
  assert.equal(t.Resources.SellerJobLogGroup.Properties.RetentionInDays, 30);
  assert.equal(withSeller({ reservedConcurrency: 0 }).Resources.SellerJobFunction.Properties.ReservedConcurrentExecutions, undefined);
});

test("seller schedule: rate(1 minute) by default, custom, or DISABLED; the permission names the rule", () => {
  const t = withSeller();
  assert.equal(t.Resources.SellerSchedule.Properties.ScheduleExpression, "rate(1 minute)");
  assert.equal(t.Resources.SellerSchedule.Properties.State, "ENABLED");
  assert.equal(withSeller({ sellerSchedule: "rate(2 minutes)" }).Resources.SellerSchedule.Properties.ScheduleExpression, "rate(2 minutes)");
  assert.equal(withSeller({ sellerSchedule: "disabled" }).Resources.SellerSchedule.Properties.State, "DISABLED");
  assert.equal(t.Resources.SellerSchedulePermission.Properties.Principal, "events.amazonaws.com");
  assert.deepEqual(t.Resources.SellerSchedulePermission.Properties.SourceArn, { "Fn::GetAtt": ["SellerSchedule", "Arn"] });
});

test("seller monitoring: the monitor gets the public addresses, the alarm uses the existing topic", () => {
  const t = withSeller();
  assert.equal(t.Resources.MonitorFunction.Properties.Environment.Variables.SELLER_BOT_ADDRESSES, `${BOT_A},${BOT_B}`);
  assert.equal(t.Resources.FaucetFunction.Properties.Environment.Variables.SELLER_BOT_ADDRESSES, `${BOT_A},${BOT_B}`);
  assert.equal(t.Resources.FaucetFunction.Properties.Environment.Variables.SELLER_FUNDING_MAX_WEI, "0", "the fund route is off by default");
  const alarm = t.Resources.SellerLowBalanceAlarm.Properties;
  assert.equal(alarm.Namespace, "BcFaucet");
  assert.equal(alarm.MetricName, "SellerBotMinBalance");
  assert.equal(alarm.Threshold, 0.5);
  assert.equal(alarm.ComparisonOperator, "LessThanThreshold");
  assert.equal(alarm.TreatMissingData, "breaching");
  assert.deepEqual(alarm.AlarmActions, [{ Ref: "AlertTopic" }]);
  assert.equal(withSeller({ sellerLowBalance: 1.5 }).Resources.SellerLowBalanceAlarm.Properties.Threshold, 1.5);
  const noAddresses = withSeller({ sellerBotAddresses: "" });
  assert.equal(noAddresses.Resources.SellerLowBalanceAlarm.Properties.TreatMissingData, "notBreaching", "no addresses = no metric: do not alarm");
  assert.equal(JSON.stringify(t).includes("privateKey"), false);
});

test("seller stack parts inherit the faucet's other settings unchanged", () => {
  const { Resources, ...rest } = withSeller();
  const { Resources: baseResources, ...baseRest } = baseline;
  assert.deepEqual(rest, baseRest);
  const changed = Object.keys(Resources).filter((name) => JSON.stringify(Resources[name]) !== JSON.stringify(baseResources[name]));
  assert.deepEqual(changed.sort(), ["FaucetFunction", "MonitorFunction", "SellerJobEventInvokeConfig", "SellerJobFunction", "SellerJobLogGroup", "SellerJobRole", "SellerLowBalanceAlarm", "SellerSchedule", "SellerSchedulePermission"]);
});

test("deploy script: --region is required for a real deploy, seller flags are validated, warnings are loud", () => {
  const real = run("deployFaucet.js", ["--env", "test", "--artifact-bucket", "b", "--secret-arn", ARN, "--admin-secret-arn", ARN, "--faucet-address", BOT_A, "--origins", "https://x.example.org"]);
  assert.match(real.stderr, /--region is required/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--dry-run", "--seller-secret-arn", "nope"]).stderr, /--seller-secret-arn must be/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--dry-run", "--seller-schedule", "every day"]).stderr, /--seller-schedule must be/);
  assert.match(run("deployFaucet.js", ["--env", "test", "--dry-run", "--seller-bot-addresses", "0x1"]).stderr, /--seller-bot-addresses must be/);
  const noAddresses = run("deployFaucet.js", ["--env", "test", "--dry-run", "--origins", "https://x.example.org", "--pid-mode", "allowlist", "--seller-secret-arn", SELLER_ARN]);
  assert.notEqual(noAddresses.status, 0, "an error, not a warning");
  assert.match(noAddresses.stderr, /--seller-bot-addresses is required with --seller-secret-arn/);
  const plain = run("deployFaucet.js", ["--env", "test", "--dry-run"]);
  assert.match(plain.stderr, /WARNING: --origins is the localhost default/);
  assert.match(plain.stderr, /WARNING: --pid-mode was not given/);
  const explicit = run("deployFaucet.js", ["--env", "test", "--dry-run", "--origins", "https://x.example.org", "--pid-mode", "allowlist"]);
  assert.equal(/WARNING: --origins|WARNING: --pid-mode was/.test(explicit.stderr), false);
  assert.doesNotMatch(plain.stdout, /Seller/);
  const seller = run("deployFaucet.js", ["--env", "test", "--dry-run", "--origins", "https://x.example.org", "--pid-mode", "allowlist", "--seller-secret-arn", SELLER_ARN, "--seller-bot-addresses", `${BOT_A},${BOT_B}`]);
  assert.equal(seller.status, 0, seller.stderr);
  assert.match(seller.stdout, /SellerJobFunction/);
});

test("createSellerBotsSecret: keys are never printed, ids are bot-1..N, test- prefix and region enforced", () => {
  const out = run("createSellerBotsSecret.js", ["--dry-run", "--count", "3"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /bot-1: 0x[0-9a-fA-F]{40}/);
  assert.match(out.stdout, /bot-3: 0x[0-9a-fA-F]{40}/);
  assert.match(out.stdout, /--seller-bot-addresses 0x/);
  assert.equal(/0x[0-9a-fA-F]{64}\b/.test(out.stdout + out.stderr), false);
  assert.match(run("createSellerBotsSecret.js", ["--name", "prod/x", "--dry-run"]).stderr, /start with test-/);
  assert.match(run("createSellerBotsSecret.js", ["--count", "3"]).stderr, /--region is required/);
  assert.match(run("createSellerBotsSecret.js", ["--dry-run", "--count", "11"]).stderr, /--count/);
});

test("printCurrentDeployArgs: flags from the live settings, the experiment code is never printed", () => {
  const require2 = createRequire(import.meta.url);
  const { buildFlags } = require2("./printCurrentDeployArgs.js");
  const env = { FAUCET_PID_MODE: "prolific", FAUCET_MAX_PAYOUTS: "40", RATE_LIMIT_PER_WINDOW: "20", GLOBAL_RATE_LIMIT_PER_WINDOW: "600", FAUCET_SECRET_ID: ARN, FAUCET_EXPERIMENT_CODE: "SUPER-SECRET-CODE", FAUCET_ADDRESS: BOT_A, SWEEP_IDLE_MINUTES: "30" };
  const out = buildFlags({ env, parameters: { AllowedOrigins: "https://a.example.org,https://b.example.org", FactoryAddress: BOT_B } });
  assert.ok(out.flags.includes("--origins https://a.example.org,https://b.example.org"));
  assert.ok(out.flags.includes("--pid-mode prolific"));
  assert.ok(out.flags.includes("--max-payouts 40"));
  assert.ok(out.flags.includes(`--secret-arn ${ARN}`));
  assert.ok(out.flags.includes(`--factory-address ${BOT_B}`));
  assert.equal(out.experimentSet, true);
  assert.equal(JSON.stringify(out).includes("SUPER-SECRET-CODE"), false);
  assert.equal(buildFlags({ env: {} }).experimentSet, false);
  // Seller bots and the other settings a redeploy would otherwise reset.
  const sellerEnv = { ...env, SELLER_BOT_ADDRESSES: `${BOT_A},${BOT_B}`, SELLER_FUNDING_MAX_WEI: "0" };
  const seller = buildFlags({ env: sellerEnv, extra: { sellerDeployed: true, sellerSecretArn: SELLER_ARN, sellerSchedule: "rate(1 minute)", sellerLowBalance: 0.5, lowBalance: 5, reservedConcurrency: 1 } });
  for (const flag of [`--seller-secret-arn ${SELLER_ARN}`, `--seller-bot-addresses ${BOT_A},${BOT_B}`, "--seller-funding-max-wei 0", '--seller-schedule "rate(1 minute)"', "--seller-low-balance 0.5", "--low-balance 5", "--reserved-concurrency 1"]) assert.ok(seller.flags.includes(flag), flag);
  assert.ok(seller.notes.includes("Seller bots are deployed: omit these flags only if you want to REMOVE them."));
  assert.ok(buildFlags({ env: sellerEnv, extra: { sellerDeployed: true, sellerSchedule: "disabled" } }).flags.includes('--seller-schedule "disabled"'));
  assert.equal(buildFlags({ env: sellerEnv, extra: { reservedConcurrency: 0 } }).flags.includes("--reserved-concurrency 0"), true);
  const without = buildFlags({ env: sellerEnv, extra: { sellerDeployed: false } });
  assert.equal(without.flags.some((flag) => flag.startsWith("--seller-")), false, "no seller flags when the stack has no seller job");
  assert.equal(JSON.stringify(seller).includes("SUPER-SECRET-CODE"), false);
  assert.match(run("printCurrentDeployArgs.js", []).stderr, /--region is required/);
});
