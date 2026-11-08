const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { consumeChallenge } = require('../../infrastructure/protected/index');
const template = require('../../infrastructure/protected/template');
const { createArchive } = require('../../infrastructure/protected/archive');
const { assertSameArchivedContent, stableJson, digest } = require('./archiveCore');

test('DynamoDB challenge consumption aliases reserved names and rejects replay atomically', async () => {
  class Update { constructor(input) { this.input = input; } }
  let consumed = false;
  const db = { send: async ({ input }) => {
    assert.equal(input.ExpressionAttributeNames['#used'], 'consumed');
    assert.equal(input.ExpressionAttributeNames['#expires'], 'expiresAt');
    assert.ok(input.ConditionExpression.includes('attribute_not_exists(#used)'));
    assert.equal(input.ExpressionAttributeValues[':now'], 123);
    if (consumed) throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' });
    consumed = true;
  } };
  assert.equal(await consumeChallenge(db, Update, 'table', 'challenge:1', 123), true);
  assert.equal(await consumeChallenge(db, Update, 'table', 'challenge:1', 123), false);
  await assert.rejects(consumeChallenge({ send: async () => { throw new Error('offline'); } }, Update, 'table', 'x', 123), /offline/);
});

test('finalizer directly finalizes the campaign and verifies the postcondition, never a catching batch', async () => {
  for (const closes of [true, false]) {
    let written = false;
    let directCalls = 0;
    let checkpoints = 0;
    const metrics = [];
    class Command { constructor(input) { this.input = input; } }
    const campaign = {
      closed: async () => written && closes,
      endTime: async () => 1n,
      finalizeAuctionIfNeeded: async () => { directCalls++; written = true; return { hash: 'public-tx', wait: async () => ({ status: 1 }) }; },
    };
    const db = { send: async command => { if (command.input.Item) checkpoints++; return {}; } };
    const mocks = {
      '@aws-sdk/client-secrets-manager': { SecretsManagerClient: class { async send() { return { SecretString: 'fixture-private-not-a-real-key' }; } }, GetSecretValueCommand: Command },
      '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
      '@aws-sdk/lib-dynamodb': { DynamoDBDocumentClient: { from: () => db }, GetCommand: Command, PutCommand: Command },
      ethers: {
        FetchRequest: class {}, Wallet: class { constructor() { this.address = 'signer'; } },
        JsonRpcProvider: class { async send() { return '0xaa36a7'; } async getTransactionCount() { return 0; } async getBlock() { return { timestamp: 100 }; } },
        Contract: class { constructor(address) { return address === 'factory' ? { getDeployedCampaigns: async () => ['auction'] } : campaign; } },
      },
    };
    const context = { exports: {}, require: name => mocks[name], process: { env: { TABLE_NAME: 'table', RPC_URL: 'https://rpc.invalid', CHAIN_ID: '11155111', FACTORY_ADDRESS: 'factory' } }, console: { log: message => metrics.push(JSON.parse(message)) } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../../infrastructure/protected/finalizer'), 'utf8'), context);
    const result = await context.exports.handler();
    assert.equal(directCalls, 1);
    assert.equal(result.ready, closes);
    assert.equal(checkpoints, 1, 'A failed auction must not starve the following range');
    assert.equal(metrics[0].Failures, closes ? 0 : 1);
    assert.equal(JSON.stringify(metrics).includes('fixture-private'), false);
  }
});

test('finalizer observability is isolated from the release-service signer permissions', () => {
  const resources = template().Resources;
  assert.ok(resources.FinalizerLogGroup);
  assert.ok(resources.FinalizerFailureAlarm);
  const releasePolicy = JSON.stringify(resources.Role);
  assert.equal(releasePolicy.includes('FinalizerSecretArn'), false);
  assert.ok(JSON.stringify(resources.FinalizerRole).includes('logs:PutLogEvents'));
});

test('administrative checkpoint batches are bounded and cannot be invoked through HTTP', async () => {
  let reads = 0;
  const archive = createArchive({ store: { get: async () => { reads++; return { receipt: { recordId: 'public-receipt' } }; } } });
  const ids = Array.from({ length: 50 }, (_, index) => '0x' + (index + 1).toString(16).padStart(64, '0'));
  const result = await archive.admin({ adminAction: 'lookup-many', archiveIds: ids });
  assert.equal(result.receipts.length, 50);
  await assert.rejects(archive.admin({ adminAction: 'lookup-many', archiveIds: [...ids, '0x' + 'f'.repeat(64)] }));
  await assert.rejects(archive.admin({ adminAction: 'lookup-many', archiveIds: [ids[0], ids[0]] }));
  await assert.rejects(archive.admin({ adminAction: 'lookup-many', archiveIds: ids, requestContext: {} }));
  assert.equal(reads, 50);
});

test('reusing verified closed archives permits only provenance-block differences, never changed rights or payloads', () => {
  const original = { source: { chainId: '11155111', factory: 'factory', auction: 'auction', blockNumber: '1', blockHash: 'original' }, seller: 'seller', winner: 'winner', payloadHash: 'ciphertext-source-digest', closed: true };
  original.snapshotHash = digest(stableJson(original));
  const observed = { ...original, source: { ...original.source, blockNumber: '100', blockHash: 'fresh' }, snapshotHash: 'fresh-snapshot' };
  assert.doesNotThrow(() => assertSameArchivedContent(original, observed));
  for (const field of ['seller', 'winner', 'payloadHash', 'closed']) assert.throws(() => assertSameArchivedContent(original, { ...observed, [field]: 'tampered' }));
  assert.throws(() => assertSameArchivedContent({ ...original, snapshotHash: 'forged' }, observed));
});
