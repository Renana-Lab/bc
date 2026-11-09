"use strict";
// Deploys the protected faucet stack (Lambda + DynamoDB + balance alarm) with CloudFormation.
// Modeled on scripts/deployLivePresence.js. NOT run automatically: see infrastructure/faucet/README.md.
//
//   node scripts/faucet/deployFaucet.js --dry-run                      builds the bundles and template locally, no AWS calls
//   node scripts/faucet/deployFaucet.js --region us-east-1 --artifact-bucket my-bucket \
//        --secret-arn arn:aws:secretsmanager:... --faucet-address 0x... --alert-email ops@example.org
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const read = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dryRun = args.includes("--dry-run");

const stackName = read("--stack", "bc-faucet");
const region = read("--region", process.env.AWS_REGION || "us-east-1");
const profile = read("--profile", process.env.AWS_PROFILE || "");
const artifactBucket = read("--artifact-bucket");
const secretArn = read("--secret-arn");
const faucetAddress = read("--faucet-address");
const alertEmail = read("--alert-email");
const rpcUrl = read("--rpc-url", "https://testnet.sapphire.oasis.io");
const chainId = Number(read("--chain-id", "23295"));
const amountWei = read("--amount-wei", "100000000000000000"); // 0.1 TEST
const lowBalance = Number(read("--low-balance", "5")); // alarm when the faucet holds fewer than this many TEST
const origins = read("--origins", "http://localhost:3000,https://datamarketplaces.net,https://www.datamarketplaces.net");
const rateLimit = read("--rate-limit", "20");

if (chainId !== 23295 && chainId !== 23293) throw new Error("--chain-id must be 23295 (Sapphire testnet) or 23293 (localnet); mainnet is refused");
if (!/^\d+$/.test(amountWei) || BigInt(amountWei) <= 0n) throw new Error("--amount-wei must be a positive integer");
if (!dryRun) {
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

const policy = (statement) => ({ PolicyName: "inline", PolicyDocument: { Version: "2012-10-17", Statement: statement } });
const assume = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
const basic = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"];

const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "Protected one-time faucet for anonymous participants (Sapphire testnet)",
  Parameters: { AllowedOrigins: { Type: "CommaDelimitedList", Default: origins } },
  Conditions: { HasAlertEmail: { "Fn::Not": [{ "Fn::Equals": [alertEmail, ""] }] } },
  Resources: {
    FaucetTable: {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
      },
    },
    FaucetRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: assume,
        ManagedPolicyArns: basic,
        Policies: [policy([
          { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"], Resource: { "Fn::GetAtt": ["FaucetTable", "Arn"] } },
          { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn || "arn:aws:secretsmanager:*:*:secret:unset" },
        ])],
      },
    },
    FaucetFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["FaucetRole", "Arn"] },
        Timeout: 30, MemorySize: 256,
        ReservedConcurrentExecutions: 1, // one signer, sequential nonces
        Environment: {
          Variables: {
            FAUCET_TABLE: { Ref: "FaucetTable" }, FAUCET_SECRET_ID: secretArn || "unset",
            RPC_URL: rpcUrl, CHAIN_ID: String(chainId), FAUCET_AMOUNT_WEI: amountWei,
            RATE_LIMIT_PER_WINDOW: rateLimit, GLOBAL_RATE_LIMIT_PER_WINDOW: "600", RATE_WINDOW_SECONDS: "600",
          },
        },
        Code: path.join(work, "faucet"),
      },
    },
    FaucetLogGroup: {
      Type: "AWS::Logs::LogGroup", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: { LogGroupName: { "Fn::Sub": "/aws/lambda/${FaucetFunction}" }, RetentionInDays: 30 },
    },
    FaucetUrl: {
      Type: "AWS::Lambda::Url",
      Properties: {
        TargetFunctionArn: { "Fn::GetAtt": ["FaucetFunction", "Arn"] }, AuthType: "NONE", InvokeMode: "BUFFERED",
        Cors: { AllowOrigins: { Ref: "AllowedOrigins" }, AllowMethods: ["POST"], AllowHeaders: ["content-type"], MaxAge: 86400 },
      },
    },
    FaucetUrlPermission: {
      Type: "AWS::Lambda::Permission",
      Properties: { Action: "lambda:InvokeFunctionUrl", FunctionName: { Ref: "FaucetFunction" }, Principal: "*", FunctionUrlAuthType: "NONE" },
    },
    FaucetInvokePermission: {
      Type: "AWS::Lambda::Permission",
      Properties: { Action: "lambda:InvokeFunction", FunctionName: { Ref: "FaucetFunction" }, Principal: "*", InvokedViaFunctionUrl: true },
    },
    MonitorRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: assume, ManagedPolicyArns: basic,
        Policies: [policy([{ Effect: "Allow", Action: "cloudwatch:PutMetricData", Resource: "*", Condition: { StringEquals: { "cloudwatch:namespace": "BcFaucet" } } }])],
      },
    },
    MonitorFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["MonitorRole", "Arn"] }, Timeout: 20, MemorySize: 128,
        Environment: { Variables: { RPC_URL: rpcUrl, CHAIN_ID: String(chainId), FAUCET_ADDRESS: faucetAddress || "0x0000000000000000000000000000000000000000" } },
        Code: path.join(work, "monitor"),
      },
    },
    MonitorSchedule: {
      Type: "AWS::Events::Rule",
      Properties: { ScheduleExpression: "rate(5 minutes)", State: "ENABLED", Targets: [{ Id: "monitor", Arn: { "Fn::GetAtt": ["MonitorFunction", "Arn"] } }] },
    },
    MonitorSchedulePermission: {
      Type: "AWS::Lambda::Permission",
      Properties: { Action: "lambda:InvokeFunction", FunctionName: { Ref: "MonitorFunction" }, Principal: "events.amazonaws.com", SourceArn: { "Fn::GetAtt": ["MonitorSchedule", "Arn"] } },
    },
    AlertTopic: {
      Type: "AWS::SNS::Topic",
      Properties: { Subscription: [{ "Fn::If": ["HasAlertEmail", { Protocol: "email", Endpoint: alertEmail || "none@example.invalid" }, { Ref: "AWS::NoValue" }] }] },
    },
    LowBalanceAlarm: {
      Type: "AWS::CloudWatch::Alarm",
      Properties: {
        AlarmDescription: `Faucet balance below ${lowBalance} TEST, or the balance monitor stopped reporting`,
        Namespace: "BcFaucet", MetricName: "FaucetBalance", Statistic: "Minimum", Period: 300, EvaluationPeriods: 1,
        Threshold: lowBalance, ComparisonOperator: "LessThanThreshold", TreatMissingData: "breaching",
        AlarmActions: [{ Ref: "AlertTopic" }], OKActions: [{ Ref: "AlertTopic" }],
      },
    },
  },
  Outputs: {
    FaucetApiUrl: { Description: "Set as REACT_APP_FAUCET_URL in AWS Amplify (the app POSTs to <url>/claim)", Value: { "Fn::GetAtt": ["FaucetUrl", "FunctionUrl"] } },
    FaucetTableName: { Description: "Pass to scripts/faucet/generatePids.js --table", Value: { Ref: "FaucetTable" } },
  },
};

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
    "--capabilities", "CAPABILITY_IAM", "--parameter-overrides", `AllowedOrigins=${origins}`, "--no-fail-on-empty-changeset",
  ]);
  const output = (key) => runAws(["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region,
    "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, "--output", "text"], true);
  console.log("\nFaucet deployed.");
  console.log(`REACT_APP_FAUCET_URL=${output("FaucetApiUrl").replace(/\/$/, "")}`);
  console.log(`Table for generatePids.js: ${output("FaucetTableName")}`);
  if (alertEmail) console.log(`Confirm the SNS subscription email sent to ${alertEmail}, otherwise balance alerts are not delivered.`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
