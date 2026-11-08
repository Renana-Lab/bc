import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDeliveryKey, exportPublicKey, fingerprintPublicKey, sealText, unwrapKey, wrapKey, openEnvelope, randomNonce, sha256 } from '../../src/protected/crypto.mjs';

const context = { chainId: 11155111, factory: `0x${'1'.repeat(40)}`, seller: `0x${'2'.repeat(40)}`, nonce: randomNonce() };
test('AES encrypted before storage; simulated KMS unwrap and winner-only rewrap; seller can disconnect', async () => {
  const kms = await generateDeliveryKey();
  const winner = await generateDeliveryKey();
  const loser = await generateDeliveryKey();
  const text = 'PROTECTED-MARKER-948713 ' + '\u05de\u05d9\u05d3\u05e2 \u05e1\u05d5\u05d3\u05d9';
  const sealed = await sealText(text, context, await exportPublicKey(kms.publicKey));
  assert(!JSON.stringify(sealed).includes(text));
  assert.equal(await sha256(JSON.stringify(sealed.envelope)), sealed.ciphertextHash);
  const raw = await unwrapKey(sealed.wrappedKey, kms.privateKey);
  try {
    const delivery = await wrapKey(raw, winner.publicKey);
    await assert.rejects(unwrapKey(delivery, loser.privateKey));
    const recovered = await unwrapKey(delivery, winner.privateKey);
    try { assert.equal(await openEnvelope(sealed.envelope, recovered, context, sealed.ciphertextHash), text); }
    finally { recovered.fill(0); }
    await assert.rejects(openEnvelope(sealed.envelope, raw, { ...context, nonce: randomNonce() }));
    const changed = { ...sealed.envelope, ciphertext: sealed.envelope.ciphertext.replace(/^./, sealed.envelope.ciphertext[0] === 'A' ? 'B' : 'A') };
    await assert.rejects(openEnvelope(changed, raw));
    await assert.rejects(openEnvelope(sealed.envelope, raw, context, `0x${'0'.repeat(64)}`));
    await assert.rejects(openEnvelope({ ...sealed.envelope, version: 2 }, raw));
  } finally { raw.fill(0); }
  assert.equal((await fingerprintPublicKey(await exportPublicKey(winner.publicKey))).length, 66);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', winner.privateKey));
});
test('fresh ciphertext per auction and strict input/context bounds', async () => {
  const kms = await generateDeliveryKey();
  const pub = await exportPublicKey(kms.publicKey);
  const a = await sealText('same text', context, pub);
  const b = await sealText('same text', context, pub);
  assert.notEqual(a.envelope.iv, b.envelope.iv);
  assert.notEqual(a.envelope.ciphertext, b.envelope.ciphertext);
  await assert.rejects(sealText('', context, pub));
  await assert.rejects(sealText('a'.repeat(1048577), context, pub));
  await assert.rejects(sealText('x', { ...context, chainId: 0 }, pub));
  await assert.rejects(sealText('x', { ...context, seller: 'invalid' }, pub));
});
