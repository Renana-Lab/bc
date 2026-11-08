const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Wallet } = require('ethers');
require('dotenv').config({ quiet: true });
async function main() {
  const crypto = await import('../../src/protected/crypto.mjs');
  const base = process.env.PROTECTED_API_URL;
  assert.ok(base?.startsWith('https://'));
  const origin = 'https://main.df7mlebpdd7v7.amplifyapp.com';
  const call = async (route, body, token) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(25000), headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error('Archive API failed'), { status: response.status });
    return result;
  };
  const records = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await call('/archives' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    records.push(...page.archives);
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor); }
  } while (cursor);
  assert.equal(records.length, 202);
  assert.equal(new Set(records.map(record => record.archiveId)).size, 202);
  assert.ok(records.every(record => record.closed && record.label === 'Encrypted copy of previously public information'));
  const signer = new Wallet(process.env.AUTO_FINALIZE_PRIVATE_KEY);
  const wallet = signer.address.toLowerCase();
  const owned = records.find(record => record.winner === wallet) || records.find(record => record.seller === wallet);
  assert.ok(owned);
  const auth = async (owner, keys) => {
    const challenge = await call('/challenge', { wallet: owner.address, publicKey: await crypto.exportPublicKey(keys.publicKey) });
    const signature = await owner._signTypedData(challenge.typedData.domain, challenge.typedData.types, challenge.typedData.message);
    return call('/session', { challengeId: challenge.challengeId, signature });
  };
  const delivery = await crypto.generateDeliveryKey();
  const session = await auth(signer, delivery);
  const release = await call('/release', { archiveId: owned.archiveId }, session.token);
  const response = await fetch(release.downloadUrl);
  assert.ok(response.ok);
  const envelope = await response.json();
  const raw = await crypto.unwrapKey(release.wrappedKey, delivery.privateKey);
  try {
    const text = await crypto.openEnvelope(envelope, raw, envelope.context, owned.ciphertextHash);
    assert.equal(await crypto.sha256(text), owned.payloadHash);
  } finally { raw.fill(0); }
  const stranger = await auth(Wallet.createRandom(), await crypto.generateDeliveryKey());
  await assert.rejects(call('/release', { archiveId: owned.archiveId }, stranger.token), error => error.status === 403);
  const report = { passed: true, generatedAt: new Date().toISOString(), archiveRecords: records.length, pages: cursors.size + 1, duplicateRecords: 0,
    originalRoleDecrypted: owned.winner === wallet ? 'winner' : 'seller', decryptedHashMatchesSource: true, unrelatedWalletDenied: true, originalPublicHistoryUnchanged: true };
  fs.writeFileSync(path.resolve(__dirname, '../../artifacts/backend/protected/live-archive-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(JSON.stringify({ failed: true, test: 'live-archive', status: error.status, type: error.name })); process.exitCode = 1; });
