'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, publicEncrypt, privateDecrypt, constants, randomBytes } = require('node:crypto');
const { createService, hash } = require('../../infrastructure/protected/service');
const { createArchive } = require('../../infrastructure/protected/archive');
const sig = require('@metamask/eth-sig-util');
const Web3 = require('web3');
const web3 = new Web3();
const secret = Buffer.from('11'.repeat(32), 'hex');
const wallet = web3.eth.accounts.privateKeyToAccount('0x' + secret.toString('hex')).address.toLowerCase();
const factory = '0x' + '22'.repeat(20);
const auction = '0x' + '33'.repeat(20);
const stranger = '0x' + '44'.repeat(20);
const origin = 'https://marketplace.example';
const nonce = '0x' + '55'.repeat(32);
let rsa, other, publicKey, otherKey, cryptoModule;
before(async () => {
  rsa = generateKeyPairSync('rsa', { modulusLength: 3072 });
  other = generateKeyPairSync('rsa', { modulusLength: 3072 });
  publicKey = rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  otherKey = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  cryptoModule = await import('../../src/protected/crypto.mjs');
});
function harness() {
  const items = new Map();
  let clock = 1700000000000;
  let decrypts = 0;
  let object;
  const config = { factory, chainId: 11155111, origins: [origin], kmsKeyId: 'isolated-key' };
  const store = {
    get: async key => items.get(key),
    create: async (key, value) => { if (items.has(key)) throw new Error('Duplicate'); items.set(key, value); },
    consume: async (key, epoch) => { const item = items.get(key); if (!item || item.consumed || item.expiresAt <= epoch) return false; item.consumed = true; return true; },
    complete: async (key, versionId) => { items.set(key, { ...items.get(key), ready: true, versionId }); },
    listArchives: async () => [...items.values()].filter(x => x.kind === 'archive')
  };
  const objects = { uploadUrl: async () => 'https://s3.example/upload', downloadUrl: async (_, version) => 'https://s3.example/download?versionId=' + version, read: async () => object, write: async () => 'archive-version' };
  const kms = { publicKey: async () => publicKey, decrypt: async data => { decrypts++; return privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, data); } };
  let state = { chainId: 11155111, factory, member: true, seller: wallet, winner: stranger, closed: false, ended: false, version: 1, id: nonce, ciphertextHash: '0x' + '77'.repeat(32), sellerKeyHash: hash(Buffer.from(publicKey, 'base64')), winnerKeyHash: '0x' + '0'.repeat(64) };
  const chain = { snapshot: async () => state, legacySnapshot: async () => { throw new Error('not configured'); } };
  const archive = createArchive({ config, store, objects, kms, chain });
  const service = createService({ config, store, objects, kms, chain, archive, now: () => clock,
    payloadId: () => nonce,
    verifyTypedData: (data, signature) => {
      const { EIP712Domain, ...types } = data.types;
      return require('ethers').utils.verifyTypedData(data.domain, types, data.message, signature);
    }
  });
  const request = async (path, body, token, headers = {}) => {
    const response = await service({ rawPath: path, headers: { origin, ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) }, requestContext: { http: { method: body === undefined ? 'GET' : 'POST' } }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.statusCode, data: JSON.parse(response.body), headers: response.headers };
  };
  const challenge = () => request('/challenge', { wallet, publicKey });
  const sign = typedData => sig.signTypedData({ privateKey: secret, data: typedData, version: sig.SignTypedDataVersion.V4 });
  const login = async () => { const c = await challenge(); const result = await request('/session', { challengeId: c.data.challengeId, signature: sign(c.data.typedData) }); assert.equal(result.status, 200); return result.data.token; };
  const prepare = async (token, transform = () => {}) => {
    const sealed = await cryptoModule.sealText('SECRET-CANARY-עברית', { chainId: 11155111, factory, seller: wallet, nonce }, publicKey);
    await transform(sealed);
    object = { bytes: Buffer.from(JSON.stringify(sealed.envelope)), version: 'immutable-version' };
    state.ciphertextHash = sealed.ciphertextHash = hash(object.bytes);
    const upload = await request('/uploads', { nonce, wrappedKey: sealed.wrappedKey, ciphertextHash: sealed.ciphertextHash, envelopeBytes: object.bytes.length }, token);
    assert.equal(upload.status, 200);
    return sealed;
  };
  return { items, request, login, challenge, sign, prepare, state, archive, chain, setObject: x => { object = x; }, tick: seconds => { clock += seconds * 1000; }, decrypts: () => decrypts };
}
test('config is public but excludes secrets and finalizer readiness defaults false', async () => {
  const h = harness(); const r = await h.request('/config'); assert.equal(r.status, 200); assert.equal(r.data.publicKey, publicKey); assert.equal(r.data.finalizerConfigured, false); assert.equal(r.headers['Cache-Control'], 'no-store');
});
test('wrong origin denied; claiming wallet cannot authorize upload', async () => {
  const h = harness(); assert.equal((await h.request('/config', undefined, null, { origin: 'https://evil.example' })).status, 403); assert.equal((await h.request('/uploads', { wallet })).status, 401);
});
test('reject malformed RSA key', async () => { assert.equal((await harness().request('/challenge', { wallet, publicKey: 'bad' })).status, 400); });
test('real EIP712 signature creates session; challenge is consumed exactly once concurrently', async () => {
  const h = harness(); const c = await h.challenge(); const body = { challengeId: c.data.challengeId, signature: h.sign(c.data.typedData) }; const r = await Promise.all([h.request('/session', body), h.request('/session', body)]); assert.deepEqual(r.map(x => x.status).sort(), [200, 401]);
});
test('modified challenge signature denied and no session issued', async () => {
  const h = harness(); const c = await h.challenge(); c.data.typedData.message.origin = 'https://evil.example'; assert.equal((await h.request('/session', { challengeId: c.data.challengeId, signature: h.sign(c.data.typedData) })).status, 401);
});
test('challenge expires before DynamoDB TTL deletion', async () => {
  const h = harness(); const c = await h.challenge(); h.tick(300); assert.equal((await h.request('/session', { challengeId: c.data.challengeId, signature: h.sign(c.data.typedData) })).status, 401);
});
test('session token is stored hashed, expires and is bound to origin', async () => {
  const h = harness(); const token = await h.login(); assert.ok(!JSON.stringify([...h.items.values()]).includes(token)); h.tick(3600); assert.equal((await h.request('/uploads', {}, token)).status, 401);
});
test('envelope SHA and dimensions validated before pinning; no plaintext returned', async () => {
  const h = harness(); const token = await h.login(); const sealed = await h.prepare(token);
  const r = await h.request('/uploads/' + nonce + '/complete', {}, token); assert.equal(r.status, 200); assert.equal(h.items.get('payload:' + nonce).versionId, 'immutable-version'); assert.ok(!JSON.stringify(r).includes('SECRET-CANARY')); assert.ok(!JSON.stringify([...h.items.values()]).includes('SECRET-CANARY')); assert.ok(!JSON.stringify(sealed.envelope).includes('SECRET-CANARY'));
});
test('modified ciphertext fails completion with no KMS calls', async () => {
  const h = harness(); const token = await h.login(); await h.prepare(token); h.setObject({ bytes: Buffer.from('{}'), version: 'tampered' }); assert.equal((await h.request('/uploads/' + nonce + '/complete', {}, token)).status, 400); assert.equal(h.decrypts(), 0);
});
test('valid 32-byte wrapped key for different ciphertext cannot mark an upload ready', async () => {
  const h = harness();
  const token = await h.login();
  await h.prepare(token, async sealed => {
    const unrelated = await cryptoModule.sealText('other text', sealed.envelope.context, publicKey);
    sealed.wrappedKey = unrelated.wrappedKey;
  });
  const result = await h.request('/uploads/' + nonce + '/complete', {}, token);
  assert.equal(result.status, 400);
  assert.equal(result.data.error, 'payload_key_mismatch');
  assert.equal(h.decrypts(), 1);
  assert.equal(h.items.get('payload:' + nonce).ready, false);
  assert.equal((await h.request('/release', { auction, publicKey })).data.error, 'payload_unavailable');
});
test('matching object hash does not bypass GCM tag verification', async () => {
  const h = harness();
  const token = await h.login();
  await h.prepare(token, sealed => {
    const ciphertext = Buffer.from(sealed.envelope.ciphertext, 'base64');
    ciphertext[ciphertext.length - 1] ^= 1;
    sealed.envelope.ciphertext = ciphertext.toString('base64');
  });
  const result = await h.request('/uploads/' + nonce + '/complete', {}, token);
  assert.equal(result.status, 400);
  assert.equal(result.data.error, 'payload_key_mismatch');
  assert.equal(h.items.get('payload:' + nonce).versionId, undefined);
});
test('upload conflicting nonce cannot overwrite metadata', async () => {
  const h = harness(); const t = await h.login(); const sealed = await h.prepare(t); assert.equal((await h.request('/uploads', { nonce, ciphertextHash: '0x' + '88'.repeat(32), wrappedKey: sealed.wrappedKey, envelopeBytes: Buffer.byteLength(JSON.stringify(sealed.envelope)) }, t)).status, 409);
});
test('transaction-bound seller receives only rewrapped key, decrypts original text', async () => {
  const h = harness(); const token = await h.login(); const sealed = await h.prepare(token); await h.request('/uploads/' + nonce + '/complete', {}, token);
  const result = await h.request('/release', { auction, publicKey }); assert.equal(result.status, 200); assert.match(result.data.downloadUrl, /immutable-version/);
  const raw = privateDecrypt({ key: rsa.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(result.data.wrappedKey, 'base64'));
  assert.equal(await cryptoModule.openEnvelope(sealed.envelope, raw), 'SECRET-CANARY-עברית'); raw.fill(0);
});
test('public key substitution fails before KMS decrypt', async () => {
  const h = harness(); const token = await h.login(); await h.prepare(token); await h.request('/uploads/' + nonce + '/complete', {}, token); const before = h.decrypts(); assert.equal((await h.request('/release', { auction, publicKey: otherKey })).status, 403); assert.equal(h.decrypts(), before);
});
test('session cannot redirect delivery to arbitrary key', async () => { const h = harness(); const token = await h.login(); assert.equal((await h.request('/release', { auction, publicKey: otherKey }, token)).status, 403); });
test('winner release requires closed and ended state; zero winner blocked', async () => {
  const h = harness(); const token = await h.login(); await h.prepare(token); await h.request('/uploads/' + nonce + '/complete', {}, token);
  const beforeRelease = h.decrypts();
  h.state.seller = stranger; h.items.get('payload:' + nonce).wallet = stranger; h.state.sellerKeyHash = '0x' + '0'.repeat(64); h.state.winner = wallet; h.state.winnerKeyHash = hash(Buffer.from(publicKey, 'base64'));
  for (const [closed, ended] of [[false, false], [true, false], [false, true]]) {
    Object.assign(h.state, { closed, ended });
    const pending = await h.request('/release', { auction, publicKey });
    assert.equal(pending.status, 409);
    assert.equal(pending.data.error, 'awaiting_confirmation');
    assert.equal(h.decrypts(), beforeRelease);
  }
  Object.assign(h.state, { closed: true, ended: true });
  assert.equal((await h.request('/release', { auction, publicKey })).status, 200);
  h.state.winner = '0x' + '0'.repeat(40);
  assert.equal((await h.request('/release', { auction, publicKey })).status, 403);
});
test('new browser requires explicit wallet recovery, and a wallet hint never releases a key', async () => {
  const h = harness(); const token = await h.login(); await h.prepare(token); await h.request('/uploads/' + nonce + '/complete', {}, token);
  const beforeRelease = h.decrypts();
  h.items.get('payload:' + nonce).wallet = stranger;
  Object.assign(h.state, { seller: stranger, sellerKeyHash: hash(Buffer.from(otherKey, 'base64')), winner: wallet, winnerKeyHash: hash(Buffer.from(otherKey, 'base64')) });
  const request = { auction, publicKey, walletHint: wallet };
  assert.equal((await h.request('/release', request)).data.error, 'awaiting_confirmation');
  assert.equal((await h.request('/release', { auction }, token)).data.error, 'awaiting_confirmation');
  Object.assign(h.state, { closed: true, ended: true });
  const recovery = await h.request('/release', request);
  assert.equal(recovery.status, 409);
  assert.equal(recovery.data.error, 'delivery_key_recovery_required');
  assert.equal(recovery.data.wrappedKey, undefined);
  assert.equal((await h.request('/release', { ...request, walletHint: factory })).status, 403);
  assert.equal(h.decrypts(), beforeRelease);
  assert.equal((await h.request('/release', { auction }, token)).status, 200);
  assert.equal(h.decrypts(), beforeRelease + 1);
});
for (const [field, value] of [['member', false], ['factory', stranger], ['chainId', 1], ['version', 0], ['ciphertextHash', '0x' + '99'.repeat(32)]]) test('untrusted state rejected: ' + field, async () => {
  const h = harness(); const token = await h.login(); await h.prepare(token); await h.request('/uploads/' + nonce + '/complete', {}, token); h.state[field] = value; assert.notEqual((await h.request('/release', { auction, publicKey })).status, 200);
});
test('provider failure returns sanitized retryable error, never stale key', async () => {
  const h = harness(); h.chain.snapshot = async () => { throw new Error('secret RPC token'); }; const r = await h.request('/release', { auction, publicKey }); assert.equal(r.status, 503); assert.ok(!JSON.stringify(r).includes('secret RPC token'));
});
test('archive routes require session for release and expose metadata only', async () => {
  const h = harness(); const r = await h.request('/archives'); assert.deepEqual(r.data, { archives: [], nextCursor: null }); assert.equal((await h.request('/release', { archiveId: nonce, publicKey })).status, 403); await assert.rejects(h.archive.admin({ requestContext: {}, adminAction: 'config' }));
});
test('archive pager traverses 251 records with bounded queries and no duplicate/lost records', async () => {
  const { createArchivePager } = require('../../infrastructure/protected/pagination');
  const records = Array.from({ length: 251 }, (_, i) => ({ pk: 'archive:0x' + i.toString(16).padStart(64, '0'), kind: 'archive', ready: true }));
  const limits = [];
  const pager = createArchivePager({
    get: async pk => records.find(r => r.pk === pk),
    query: async ({ limit, exclusiveStartKey }) => {
      limits.push(limit);
      const start = exclusiveStartKey ? records.findIndex(r => r.pk === exclusiveStartKey.pk) + 1 : 0;
      const items = records.slice(start, start + limit);
      return { Items: items, ...(start + limit < records.length ? { LastEvaluatedKey: { pk: items.at(-1).pk, kind: 'archive' } } : {}) };
    }
  });
  let cursor, all = [];
  do { const page = await pager(cursor); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(all.length, 251); assert.equal(new Set(all.map(x => x.pk)).size, 251); assert.equal(limits.length, 6); assert.ok(limits.every(x => x === 50));
});
test('archive pagination preserves cursor on empty filtered page and rejects malformed cursors before query', async () => {
  const { createArchivePager, decodeCursor } = require('../../infrastructure/protected/pagination');
  const key = { pk: 'archive:0x' + 'aa'.repeat(32), kind: 'archive' };
  let calls = 0;
  const pager = createArchivePager({ get: async () => null, query: async () => { calls++; return { Items: [], LastEvaluatedKey: key }; } });
  const page = await pager(); assert.deepEqual(page.items, []); assert.deepEqual(decodeCursor(page.nextCursor), key);
  for (const cursor of ['!', 'a'.repeat(513), Buffer.from(JSON.stringify({ pk: 'session:secret', kind: 'archive' })).toString('base64url'), Buffer.from('[]').toString('base64url')]) await assert.rejects(pager(cursor), e => e.status === 400);
  assert.equal(calls, 1);
});
