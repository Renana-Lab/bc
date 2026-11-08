'use strict';
const ref = name => ({ Ref: name });
const arn = name => ({ 'Fn::GetAtt': [name, 'Arn'] });
const sub = value => ({ 'Fn::Sub': value });
const retain = properties => ({ ...properties, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
module.exports = function template() {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Parameters: {
      Factory: { Type: 'String', AllowedPattern: '0x[0-9a-fA-F]{40}' },
      ChainId: { Type: 'Number', Default: 11155111 },
      Origins: { Type: 'CommaDelimitedList' },
      RpcUrl: { Type: 'String', Default: '', NoEcho: true },
      RpcSecretArn: { Type: 'String', Default: '' },
      LegacyFactories: { Type: 'String', Default: '' },
      FinalizerSecretArn: { Type: 'String', Default: '' }
    },
    Conditions: { HasRpcSecret: { 'Fn::Not': [{ 'Fn::Equals': [ref('RpcSecretArn'), ''] }] }, HasFinalizer: { 'Fn::Not': [{ 'Fn::Equals': [ref('FinalizerSecretArn'), ''] }] } },
    Resources: {
      PayloadKey: retain({ Type: 'AWS::KMS::Key', Properties: { Description: 'Marketplace Protected payload wrapping RSA key. Never delete while payloads exist.', KeySpec: 'RSA_3072', KeyUsage: 'ENCRYPT_DECRYPT', PendingWindowInDays: 30, KeyPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') }, Action: 'kms:*', Resource: '*' }] } } }),
      Bucket: retain({ Type: 'AWS::S3::Bucket', Properties: {
        VersioningConfiguration: { Status: 'Enabled' }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        CorsConfiguration: { CorsRules: [{ AllowedOrigins: ref('Origins'), AllowedMethods: ['GET', 'PUT'], AllowedHeaders: ['content-type', 'x-amz-*'], ExposedHeaders: ['ETag', 'x-amz-version-id'], MaxAge: 300 }] }
      } }),
      BucketPolicy: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: ref('Bucket'), PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [arn('Bucket'), sub('${Bucket.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': false } } }] } } },
      Table: retain({ Type: 'AWS::DynamoDB::Table', Properties: {
        BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'kind', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], GlobalSecondaryIndexes: [{ IndexName: 'kind-index', KeySchema: [{ AttributeName: 'kind', KeyType: 'HASH' }], Projection: { ProjectionType: 'KEYS_ONLY' } }],
        SSESpecification: { SSEEnabled: true }, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true,
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }
      } }),
      Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, Policies: [{ PolicyName: 'ProtectedPayloadAccess', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}-service:*') },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'], Resource: sub('${Bucket.Arn}/payloads/*') },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], Resource: arn('Table') },
        { Effect: 'Allow', Action: 'dynamodb:Query', Resource: sub('${Table.Arn}/index/kind-index') },
        { Effect: 'Allow', Action: ['kms:GetPublicKey', 'kms:Decrypt'], Resource: arn('PayloadKey') },
        { 'Fn::If': ['HasRpcSecret', { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('RpcSecretArn') }, ref('AWS::NoValue')] }
      ] } }] } },
      Function: { Type: 'AWS::Lambda::Function', Properties: {
        FunctionName: sub('${AWS::StackName}-service'), Runtime: 'nodejs22.x', Handler: 'index.handler', Role: arn('Role'), MemorySize: 512, Timeout: 28, ReservedConcurrentExecutions: 20,
        Code: { ZipFile: "exports.handler=async()=>({statusCode:503,body:'{\"error\":\"not_ready\"}'});" },
        Environment: { Variables: { TABLE_NAME: ref('Table'), BUCKET_NAME: ref('Bucket'), KMS_KEY_ID: arn('PayloadKey'), FACTORY_ADDRESS: ref('Factory'), CHAIN_ID: ref('ChainId'), ALLOWED_ORIGINS: { 'Fn::Join': [',', ref('Origins')] }, RPC_URL: ref('RpcUrl'), RPC_SECRET_ARN: ref('RpcSecretArn'), LEGACY_FACTORIES: ref('LegacyFactories'), FINALIZER_CONFIGURED: { 'Fn::If': ['HasFinalizer', 'true', 'false'] } } }
      } },
      LogGroup: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: sub('/aws/lambda/${AWS::StackName}-service'), RetentionInDays: 30 } },
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: sub('${AWS::StackName}-api'), ProtocolType: 'HTTP' } },
      Integration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: { ApiId: ref('Api'), IntegrationType: 'AWS_PROXY', IntegrationUri: arn('Function'), PayloadFormatVersion: '2.0' } },
      Route: { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: ref('Api'), RouteKey: '$default', Target: { 'Fn::Join': ['/', ['integrations', ref('Integration')]] } } },
      Stage: { Type: 'AWS::ApiGatewayV2::Stage', Properties: { ApiId: ref('Api'), StageName: '$default', AutoDeploy: true, DefaultRouteSettings: { ThrottlingBurstLimit: 40, ThrottlingRateLimit: 20 } } },
      Permission: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('Function'), Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*') } },
      ErrorAlarm: { Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmDescription: 'Protected key service unhandled errors', Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: ref('Function') }], Statistic: 'Sum', Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' } },
      ServiceFailureAlarm: { Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmDescription: 'Protected service fail-closed infrastructure failures', Namespace: 'MarketplaceProtected', MetricName: 'Failures', Dimensions: [{ Name: 'Service', Value: ref('Function') }], Statistic: 'Sum', Period: 60, EvaluationPeriods: 1, Threshold: 3, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' } },
      FinalizerRole: { Condition: 'HasFinalizer', Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, Policies: [{ PolicyName: 'IsolatedFinalizer', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}-finalizer:*') },
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('FinalizerSecretArn') },
        { 'Fn::If': ['HasRpcSecret', { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('RpcSecretArn') }, ref('AWS::NoValue')] },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: arn('Table') }
      ] } }] } },
      FinalizerFunction: { Condition: 'HasFinalizer', Type: 'AWS::Lambda::Function', Properties: {
        FunctionName: sub('${AWS::StackName}-finalizer'), Runtime: 'nodejs22.x', Handler: 'finalizer.handler', Role: arn('FinalizerRole'), Timeout: 55, MemorySize: 256, ReservedConcurrentExecutions: 1,
        Code: { ZipFile: 'exports.handler=async()=>({ready:false});' }, Environment: { Variables: { TABLE_NAME: ref('Table'), FACTORY_ADDRESS: ref('Factory'), CHAIN_ID: ref('ChainId'), RPC_URL: ref('RpcUrl'), RPC_SECRET_ARN: ref('RpcSecretArn'), SIGNER_SECRET_ARN: ref('FinalizerSecretArn') } }
      } },
      FinalizerSchedule: { Condition: 'HasFinalizer', Type: 'AWS::Events::Rule', Properties: { ScheduleExpression: 'rate(1 minute)', State: 'ENABLED', Targets: [{ Id: 'Finalizer', Arn: arn('FinalizerFunction'), RetryPolicy: { MaximumRetryAttempts: 0 } }] } },
      FinalizerLogGroup: { Condition: 'HasFinalizer', Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: sub('/aws/lambda/${AWS::StackName}-finalizer'), RetentionInDays: 30 } },
      FinalizerFailureAlarm: { Condition: 'HasFinalizer', Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmDescription: 'Protected finalizer fail-closed failures', Namespace: 'MarketplaceProtected', MetricName: 'Failures', Dimensions: [{ Name: 'Service', Value: ref('FinalizerFunction') }], Statistic: 'Sum', Period: 60, EvaluationPeriods: 2, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching' } },
      FinalizerPermission: { Condition: 'HasFinalizer', Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('FinalizerFunction'), Action: 'lambda:InvokeFunction', Principal: 'events.amazonaws.com', SourceArn: arn('FinalizerSchedule') } }
    },
    Outputs: {
      ApiUrl: { Value: sub('https://${Api}.execute-api.${AWS::Region}.amazonaws.com') }, FunctionName: { Value: ref('Function') },
      AdminFunctionName: { Value: ref('Function') }, BucketName: { Value: ref('Bucket') }, TableName: { Value: ref('Table') }, KmsKeyArn: { Value: arn('PayloadKey') },
      FinalizerFunctionName: { Condition: 'HasFinalizer', Value: ref('FinalizerFunction') }
    }
  };
};
