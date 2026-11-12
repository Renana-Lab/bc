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
  assert.deepEqual([...codes.Action].sort(), ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
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

test("network, alarm and exposure settings", () => {
  const env = template.Resources.FaucetFunction.Properties.Environment.Variables;
  assert.equal(env.CHAIN_ID, "23295");
  assert.equal(template.Resources.FaucetFunction.Properties.ReservedConcurrentExecutions, 1);
  assert.equal(template.Resources.LowBalanceAlarm.Properties.TreatMissingData, "breaching");
  assert.equal(template.Resources.LowBalanceAlarm.Properties.Threshold, 5);
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
  assert.match(run("deployFaucet.js", ["--env", "test", "--artifact-bucket", "b", "--secret-arn", ARN, "--faucet-address", "0x0000000000000000000000000000000000000001"]).stderr, /--admin-secret-arn is required/);
  assert.match(readFileSync(path.join(here, "deployFaucet.js"), "utf8"), /"--amount-wei", "1500000000000000000"/);
});

test("setAdminPassword refuses non-interactive input and never echoes anything password-like", () => {
  const result = spawnSync(process.execPath, [path.join(here, "setAdminPassword.js")], { input: "hunter2-hunter2\nhunter2-hunter2\n", encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes("hunter2"), false);
  assert.equal(result.stdout, "", "no hash is printed without a terminal");
});
