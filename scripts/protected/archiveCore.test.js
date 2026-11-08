const test = require('node:test');
const assert = require('node:assert/strict');
const { ZERO, LABEL, readClosedSnapshot, importSnapshot, digest, archiveIdentity } = require('./archiveCore');
const { parseArgs } = require('./archiveImport');
const { decodeInvocation, createArchiveAdminAdapter } = require('./archiveIamAdapter');
const factory = `0x${'1'.repeat(40)}`;
const auction = `0x${'2'.repeat(40)}`;
const seller = `0x${'3'.repeat(40)}`;
const winner = `0x${'4'.repeat(40)}`;
const block = { number: 100, hash: `0x${'a'.repeat(64)}`, timestamp: 2000 };
function source(overrides = {}) {
  return {
    getBlock: async () => block,
    isCampaign: async () => true,
    readAuction: async () => ({ factory, closed: true, seller, winner, highestBid: '20',
      payload: 'PRIVATE legacy marker', minimum: '10', description: 'public description', endTime: 1999, ...overrides }),
  };
}
const snapshot = (provider = source()) => readClosedSnapshot(provider, auction, block, factory, '11155111');

test('snapshot is closed-only, pinned, reproducible, metadata never contains payload', async () => {
  const result = await snapshot();
  assert.equal(result.metadata.label, LABEL);
  assert.equal(JSON.stringify(result.metadata).includes('PRIVATE'), false);
  assert.equal(result.metadata.payloadHash, digest('PRIVATE legacy marker'));
  assert.deepEqual(result.metadata, (await snapshot()).metadata);
  assert.equal(await snapshot(source({ closed: false })), null);
  assert.equal(await snapshot(source({ endTime: 2001 })), null);
  assert.ok(await snapshot(source({ endTime: 2000 })));
});
test('rejects foreign factory, orphaned chain, malformed state and missing data', async () => {
  const orphan = source(); orphan.getBlock = async () => ({ ...block, hash: `0x${'b'.repeat(64)}` });
  await assert.rejects(snapshot(orphan), /Pinned block/);
  const foreign = source(); foreign.isCampaign = async () => false;
  await assert.rejects(snapshot(foreign), /not registered/);
  await assert.rejects(snapshot(source({ factory: seller })), /mismatch/);
  await assert.rejects(snapshot(source({ seller: ZERO })), /Missing seller/);
  await assert.rejects(snapshot(source({ winner: ZERO })), /Inconsistent/);
  await assert.rejects(snapshot(source({ payload: '' })), /missing/);
});
test('no-bid archive only retains seller access identity', async () => {
  const result = await snapshot(source({ winner: ZERO, highestBid: '0' }));
  assert.equal(result.metadata.winner, ZERO);
});
test('identities deduplicate across blocks, not across source deployments', () => {
  assert.equal(archiveIdentity(1, factory, auction), archiveIdentity('1', factory.toUpperCase().replace('0X', '0x'), auction));
  assert.notEqual(archiveIdentity(1, factory, auction), archiveIdentity(2, factory, auction));
});
test('administrative upload never receives plaintext and validated receipts resume safely', async () => {
  const record = await snapshot();
  let uploads = 0;
  let receipt;
  const target = {
    getEncryptionConfig: async () => ({ publicKey: 'spki' }),
    lookupArchive: async () => receipt,
    importArchive: async (request) => {
      uploads++;
      assert.equal(JSON.stringify(request).includes('PRIVATE'), false);
      receipt = { archiveId: request.metadata.archiveId, snapshotHash: request.metadata.snapshotHash,
        ciphertextHash: request.ciphertextHash, recordId: 'immutable-version' };
      return receipt;
    },
  };
  const params = { snapshot: record, target, context: {}, sealText: async (payload) => {
    assert.equal(payload, 'PRIVATE legacy marker');
    return { envelope: { ciphertext: 'opaque' }, wrappedKey: 'wrapped', ciphertextHash: digest('cipher') };
  } };
  const first = await importSnapshot(params);
  assert.equal(uploads, 1);
  await importSnapshot({ ...params, checkpointEntry: first });
  await importSnapshot(params);
  assert.equal(uploads, 1);
  await assert.rejects(importSnapshot({ ...params, checkpointEntry: { ...first, snapshotHash: digest('wrong') } }), /conflicts/);
  target.lookupArchive = async () => null;
  await assert.rejects(importSnapshot({ ...params, checkpointEntry: first }), /cannot be confirmed/);
});
test('upload failure is fatal and wrong ciphertext receipt rejected', async () => {
  const record = await snapshot();
  const params = { snapshot: record, context: {}, sealText: async () => ({ ciphertextHash: digest('a') }), target: {
    lookupArchive: async () => null, getEncryptionConfig: async () => ({ publicKey: 'spki' }),
    importArchive: async () => { throw new Error('AWS unavailable'); },
  } };
  await assert.rejects(importSnapshot(params), /AWS unavailable/);
  params.target.importArchive = async () => ({ archiveId: record.metadata.archiveId,
    snapshotHash: record.metadata.snapshotHash, ciphertextHash: digest('b'), recordId: 'v' });
  await assert.rejects(importSnapshot(params), /hash mismatch/);
});
test('CLI defaults dry-run and rejects unsafe execution configuration', () => {
  const args = ['--rpc', 'http://localhost:8545', '--source-factory', factory];
  assert.equal(parseArgs(args).execute, false);
  assert.throws(() => parseArgs([...args, '--execute']), /requires/);
  assert.throws(() => parseArgs([...args, '--confirmations', '0']), /Invalid/);
  assert.throws(() => parseArgs([...args, '--limit', 'NaN']), /Invalid/);
  assert.throws(() => parseArgs([...args, '--block', 'latest']), /integer/);
});
test('IAM adapter rejects Lambda errors, HTTP failures and missing function', async () => {
  assert.throws(() => decodeInvocation({ FunctionError: 'Unhandled' }, {}), /failed/);
  assert.throws(() => decodeInvocation({}, { statusCode: 403, body: '{}' }), /rejected/);
  assert.throws(() => decodeInvocation({}, { error: 'forbidden' }), /rejected/);
  assert.deepEqual(decodeInvocation({}, { statusCode: 200, body: '{"publicKey":"abc"}' }), { publicKey: 'abc' });
  assert.equal(decodeInvocation({}, null), null);
  const previous = process.env.PROTECTED_SERVICE_FUNCTION;
  delete process.env.PROTECTED_SERVICE_FUNCTION;
  try {
    await assert.rejects(createArchiveAdminAdapter({ identity: { Account: '774490039997' } }), /PROTECTED_SERVICE_FUNCTION/);
  } finally {
    if (previous !== undefined) process.env.PROTECTED_SERVICE_FUNCTION = previous;
  }
});
