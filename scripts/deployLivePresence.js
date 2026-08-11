const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const handlerCode = fs.readFileSync(
  path.join(root, "infrastructure", "live-presence", "handler.js"),
  "utf8",
);
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const stackName = readArg("--stack", "bc-live-presence");
const region = readArg("--region", process.env.AWS_REGION || "us-east-1");
const profile = readArg("--profile", process.env.AWS_PROFILE || "");
const origins = readArg(
  "--origins",
  "http://localhost:3000,https://datamarketplaces.net,https://www.datamarketplaces.net",
);

const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "Serverless anonymous live-presence telemetry for Blockchain Data Market",
  Parameters: {
    AllowedOrigins: {
      Type: "CommaDelimitedList",
      Default: origins,
      Description: "Origins allowed to call the live presence function URL",
    },
  },
  Resources: {
    PresenceTable: {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
      },
    },
    ActivityTable: {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "day", AttributeType: "S" },
          { AttributeName: "timestamp", AttributeType: "N" },
        ],
        KeySchema: [
          { AttributeName: "day", KeyType: "HASH" },
          { AttributeName: "timestamp", KeyType: "RANGE" },
        ],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
      },
    },
    PresenceRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
        },
        ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
        Policies: [{
          PolicyName: "PresenceTables",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: ["dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan"],
              Resource: [
                { "Fn::GetAtt": ["PresenceTable", "Arn"] },
                { "Fn::GetAtt": ["ActivityTable", "Arn"] },
              ],
            }],
          },
        }],
      },
    },
    PresenceFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: { "Fn::GetAtt": ["PresenceRole", "Arn"] },
        Timeout: 15,
        MemorySize: 256,
        Environment: {
          Variables: {
            PRESENCE_TABLE: { Ref: "PresenceTable" },
            ACTIVITY_TABLE: { Ref: "ActivityTable" },
            PRESENCE_TTL_SECONDS: "60",
            HISTORY_TTL_DAYS: "400",
          },
        },
        Code: { ZipFile: handlerCode },
      },
    },
    PresenceLogGroup: {
      Type: "AWS::Logs::LogGroup",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        LogGroupName: { "Fn::Sub": "/aws/lambda/${PresenceFunction}" },
        RetentionInDays: 30,
      },
    },
    PresenceUrl: {
      Type: "AWS::Lambda::Url",
      Properties: {
        TargetFunctionArn: { "Fn::GetAtt": ["PresenceFunction", "Arn"] },
        AuthType: "NONE",
        InvokeMode: "BUFFERED",
        Cors: {
          AllowOrigins: { Ref: "AllowedOrigins" },
          AllowMethods: ["GET", "POST"],
          AllowHeaders: ["content-type"],
          MaxAge: 86400,
        },
      },
    },
    PresenceUrlPermission: {
      Type: "AWS::Lambda::Permission",
      Properties: {
        Action: "lambda:InvokeFunctionUrl",
        FunctionName: { Ref: "PresenceFunction" },
        Principal: "*",
        FunctionUrlAuthType: "NONE",
      },
    },
    PresenceInvokePermission: {
      Type: "AWS::Lambda::Permission",
      Properties: {
        Action: "lambda:InvokeFunction",
        FunctionName: { Ref: "PresenceFunction" },
        Principal: "*",
        InvokedViaFunctionUrl: true,
      },
    },
  },
  Outputs: {
    PresenceApiUrl: {
      Description: "Set this value as REACT_APP_PRESENCE_API_URL in AWS Amplify",
      Value: { "Fn::GetAtt": ["PresenceUrl", "FunctionUrl"] },
    },
  },
};

const templatePath = path.join(os.tmpdir(), `${stackName}-template-${Date.now()}.json`);
fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));

const resolveAwsExecutable = () => {
  if (process.env.AWS_CLI_PATH) return process.env.AWS_CLI_PATH;
  if (process.platform !== "win32") return "aws";

  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Amazon", "AWSCLIV2", "aws.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Amazon", "AWSCLIV2", "aws.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "aws.exe";
};

const awsExecutable = resolveAwsExecutable();
const runAws = (commandArgs, capture = false) => {
  const argsWithProfile = profile ? [...commandArgs, "--profile", profile] : commandArgs;
  const result = spawnSync(awsExecutable, argsWithProfile, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) {
    throw new Error(`Could not start the AWS CLI at ${awsExecutable}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`AWS command failed: aws ${argsWithProfile.join(" ")}`);
  }
  return String(result.stdout || "").trim();
};

try {
  runAws([
    "cloudformation", "deploy",
    "--template-file", templatePath,
    "--stack-name", stackName,
    "--region", region,
    "--capabilities", "CAPABILITY_NAMED_IAM",
    "--parameter-overrides", `AllowedOrigins=${origins}`,
    "--no-fail-on-empty-changeset",
  ]);

  const apiUrl = runAws([
    "cloudformation", "describe-stacks",
    "--stack-name", stackName,
    "--region", region,
    "--query", "Stacks[0].Outputs[?OutputKey=='PresenceApiUrl'].OutputValue | [0]",
    "--output", "text",
  ], true);

  console.log("\nLive presence deployed successfully.");
  console.log(`REACT_APP_PRESENCE_API_URL=${apiUrl}`);
  console.log("Add that environment variable to the production and testing branches in AWS Amplify, then redeploy.");
} finally {
  try {
    fs.unlinkSync(templatePath);
  } catch (_) {}
}
