"use strict";
// CloudFormation template for the protected faucet (test environment). Pure function of its options so it
// can be checked in tests without AWS. Used by scripts/faucet/deployFaucet.js.
const TEST_PREFIX = "test-";

const buildTemplate = ({
  origins, alertEmail = "", secretArn = "", faucetAddress = "", rpcUrl, chainId, amountWei, lowBalance,
  rateLimit = "20", reservedConcurrency = 1, faucetCodeDir, monitorCodeDir,
}) => {
const policy = (statement) => ({ PolicyName: "inline", PolicyDocument: { Version: "2012-10-17", Statement: statement } });
  const assume = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  const basic = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"];
  return {
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
    RateTable: {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        // Deliberately NO point-in-time recovery or backups: expired caller records must not be retained.
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
          { Effect: "Allow", Action: "dynamodb:UpdateItem", Resource: { "Fn::GetAtt": ["RateTable", "Arn"] } },
          { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn || "arn:aws:secretsmanager:*:*:secret:unset" },
        ])],
      },
    },
    FaucetFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["FaucetRole", "Arn"] },
        Timeout: 30, MemorySize: 256,
        // One signer, sequential nonces. Needs an account concurrency quota above 10; --reserved-concurrency 0 omits it
        // (signing is still serialized inside one container, but parallel containers could then collide on nonces).
        ...(reservedConcurrency > 0 ? { ReservedConcurrentExecutions: reservedConcurrency } : {}),
        Environment: {
          Variables: {
            FAUCET_TABLE: { Ref: "FaucetTable" }, RATE_TABLE: { Ref: "RateTable" }, RATE_TTL_GRACE_SECONDS: "60", FAUCET_SECRET_ID: secretArn || "unset",
            RPC_URL: rpcUrl, CHAIN_ID: String(chainId), FAUCET_AMOUNT_WEI: amountWei,
            RATE_LIMIT_PER_WINDOW: rateLimit, GLOBAL_RATE_LIMIT_PER_WINDOW: "600", RATE_WINDOW_SECONDS: "600",
          },
        },
        Code: faucetCodeDir,
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
    MonitorLogGroup: {
      Type: "AWS::Logs::LogGroup", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: { LogGroupName: { "Fn::Sub": "/aws/lambda/${MonitorFunction}" }, RetentionInDays: 30 },
    },
    MonitorFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["MonitorRole", "Arn"] }, Timeout: 20, MemorySize: 128,
        Environment: { Variables: { RPC_URL: rpcUrl, CHAIN_ID: String(chainId), FAUCET_ADDRESS: faucetAddress || "0x0000000000000000000000000000000000000000" } },
        Code: monitorCodeDir,
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
};

module.exports = { buildTemplate, TEST_PREFIX };
