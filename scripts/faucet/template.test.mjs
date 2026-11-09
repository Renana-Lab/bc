// Offline checks of the faucet CloudFormation template and the test-environment guards of the deploy
// scripts. Nothing here talks to AWS (every script run below is a dry run or fails before any call).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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
  assert.equal(template.Resources.FaucetUrl.Properties.Cors.AllowMethods.length, 1);
  assert.deepEqual(template.Resources.FaucetUrl.Properties.Cors.AllowMethods, ["POST"]);
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
