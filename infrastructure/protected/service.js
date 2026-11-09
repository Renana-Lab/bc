'use strict';
const { isUtf8 } = require('node:buffer');
const { randomBytes, createHash, createDecipheriv, createPublicKey, publicEncrypt, constants } = require('node:crypto');
const hash = bytes => '0x' + createHash('sha256').update(bytes).digest('hex');
const address = v => typeof v === 'string' && /^0x[\da-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
const hex32 = v => typeof v === 'string' && /^0x[\da-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
const b64 = v => {
  if (typeof v !== 'string' || !v.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) fail(400, 'invalid_base64');
  return Buffer.from(v, 'base64');
};
function fail(status, code) { const e = new Error(code); e.status = status; throw e; }
function deliveryKey(encoded) {
  const der = b64(encoded);
  if (der.length > 1024) fail(400, 'invalid_public_key');
  let key;
  try { key = createPublicKey({ key: der, type: 'spki', format: 'der' }); } catch { fail(400, 'invalid_public_key'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 3072 || key.asymmetricKeyDetails.publicExponent !== 65537n) fail(400, 'invalid_public_key');
  return { key, keyHash: hash(der) };
}

// Adapters intentionally keep AWS and chain dependencies outside the protocol tests.
function createService({ config, store, objects, kms, chain, verifyTypedData, payloadId, archive, now = () => Date.now() }) {
  const epoch = () => Math.floor(now() / 1000);
  const origins = new Set(config.origins);
  const factory = config.factory.toLowerCase();
  async function session(event, origin) {
    const token = (event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer /, '');
    if (!/^[a-f0-9]{64}$/.test(token)) fail(401, 'session_required');
    const s = await store.get('session:' + hash(token));
    if (!s || s.expiresAt <= epoch() || s.origin !== origin || s.factory !== factory || s.chainId !== config.chainId) fail(401, 'session_expired');
    return s;
  }
  async function route(event, origin, method, path, body) {
    if (method === 'GET' && path === '/config') return { version: 1, chainId: config.chainId, factory, publicKey: await kms.publicKey(), kmsKeyId: config.kmsKeyId, confirmations: 12, finalizerConfigured: config.finalizerConfigured === true };
    if (method === 'GET' && path === '/archives' && archive) return archive.list(event.queryStringParameters?.cursor);
    if (method === 'POST' && path === '/challenge') {
      if (!address(body.wallet)) fail(400, 'invalid_wallet');
      const { keyHash } = deliveryKey(body.publicKey);
      const challengeId = randomBytes(32).toString('hex');
      const expiresAt = epoch() + 300;
      const wallet = body.wallet.toLowerCase();
      const typedData = {
        domain: { name: 'Marketplace Protected', version: '1', chainId: config.chainId, verifyingContract: factory },
        primaryType: 'ProtectedSession',
        types: {
          EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
          ProtectedSession: [{ name: 'wallet', type: 'address' }, { name: 'keyHash', type: 'bytes32' }, { name: 'origin', type: 'string' }, { name: 'nonce', type: 'bytes32' }, { name: 'expiresAt', type: 'uint256' }],
        },
        message: { wallet, keyHash, origin, nonce: '0x' + challengeId, expiresAt }
      };
      await store.create('challenge:' + challengeId, { wallet, publicKey: body.publicKey, keyHash, origin, expiresAt, typedData });
      return { challengeId, typedData, expiresAt };
    }
    if (method === 'POST' && path === '/session') {
      if (!/^[a-f0-9]{64}$/.test(body.challengeId || '') || !/^0x[\da-f]{130}$/i.test(body.signature || '')) fail(400, 'invalid_signature');
      const id = 'challenge:' + body.challengeId;
      const challenge = await store.get(id);
      if (!challenge || challenge.expiresAt <= epoch() || challenge.origin !== origin) fail(401, 'challenge_expired');
      let recovered;
      try { recovered = await verifyTypedData(challenge.typedData, body.signature); } catch { fail(401, 'invalid_signature'); }
      if (recovered.toLowerCase() !== challenge.wallet) fail(401, 'invalid_signature');
      if (!await store.consume(id, epoch())) fail(401, 'challenge_used');
      const token = randomBytes(32).toString('hex');
      const expiresAt = epoch() + 3600;
      await store.create('session:' + hash(token), { wallet: challenge.wallet, publicKey: challenge.publicKey, keyHash: challenge.keyHash, origin, chainId: config.chainId, factory, expiresAt });
      return { token, wallet: challenge.wallet, keyHash: challenge.keyHash, expiresAt };
    }
    if (method === 'POST' && path === '/uploads') {
      const s = await session(event, origin);
      if (!hex32(body.nonce) || !hex32(body.ciphertextHash) || b64(body.wrappedKey).length !== 384 || !Number.isSafeInteger(body.envelopeBytes) || body.envelopeBytes < 1 || body.envelopeBytes > 1400000) fail(400, 'invalid_upload');
      const nonce = body.nonce.toLowerCase();
      const id = payloadId(config.chainId, factory, s.wallet, nonce).toLowerCase();
      const key = 'payload:' + id;
      let record = await store.get(key);
      if (record && (record.ciphertextHash !== body.ciphertextHash.toLowerCase() || record.wrappedKey !== body.wrappedKey || record.wallet !== s.wallet || record.envelopeBytes !== body.envelopeBytes)) fail(409, 'upload_conflict');
      if (!record) {
        record = { id, wallet: s.wallet, nonce, factory, chainId: config.chainId, ciphertextHash: body.ciphertextHash.toLowerCase(), wrappedKey: body.wrappedKey, envelopeBytes: body.envelopeBytes, objectKey: 'payloads/' + id + '.json', ready: false };
        try { await store.create(key, record); } catch { fail(409, 'upload_conflict'); }
      }
      if (record.ready) return { id, ready: true, ciphertextHash: record.ciphertextHash };
      return { id, uploadUrl: await objects.uploadUrl(record.objectKey, record.envelopeBytes), expiresIn: 300 };
    }
    const upload = /^\/uploads\/(0x[\da-f]{64})\/complete$/i.exec(path);
    if (method === 'POST' && upload) {
      const s = await session(event, origin);
      const key = 'payload:' + upload[1].toLowerCase();
      const record = await store.get(key);
      if (!record || record.wallet !== s.wallet) fail(404, 'upload_not_found');
      if (!record.ready) {
        const object = await objects.read(record.objectKey);
        if (!object.version || object.bytes.length !== record.envelopeBytes || object.bytes.length > 1400000 || hash(object.bytes) !== record.ciphertextHash) fail(400, 'invalid_envelope');
        let e;
        try { e = JSON.parse(object.bytes.toString('utf8')); } catch { fail(400, 'invalid_envelope'); }
        const c = e?.context;
        if (e?.version !== 1 || !c || c.chainId !== record.chainId || c.factory !== factory || c.seller !== s.wallet || c.nonce !== record.nonce) fail(400, 'invalid_envelope');
        const iv = b64(e.iv);
        const ciphertext = b64(e.ciphertext);
        if (iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > 1048592 || Object.keys(e).sort().join(',') !== 'ciphertext,context,iv,version' || Object.keys(c).sort().join(',') !== 'chainId,factory,nonce,seller') fail(400, 'invalid_envelope');
        let raw, plain, tail;
        try {
          try { raw = await kms.decrypt(b64(record.wrappedKey)); }
          catch { fail(400, 'invalid_wrapped_key'); }
          if (raw.length !== 32) fail(400, 'invalid_wrapped_key');
          // Match the browser's canonical AAD and authenticate the ciphertext before pinning.
          const aad = Buffer.from(JSON.stringify({ version: 1, chainId: record.chainId, factory, seller: s.wallet, nonce: record.nonce }));
          try {
            const decipher = createDecipheriv('aes-256-gcm', raw, iv, { authTagLength: 16 });
            decipher.setAAD(aad);
            decipher.setAuthTag(ciphertext.subarray(-16));
            plain = decipher.update(ciphertext.subarray(0, -16));
            tail = decipher.final();
          } catch { fail(400, 'payload_key_mismatch'); }
          if (tail.length || !isUtf8(plain)) fail(400, 'invalid_envelope');
        } finally { raw?.fill(0); plain?.fill(0); tail?.fill(0); }
        await store.complete(key, object.version);
      }
      return { id: record.id, ready: true, ciphertextHash: record.ciphertextHash };
    }
    if (method === 'POST' && path === '/release') {
      if (!body.archiveId && !address(body.auction)) fail(400, 'invalid_auction');
      let s;
      if (event.headers?.authorization || event.headers?.Authorization) s = await session(event, origin);
      if (s && body.publicKey && body.publicKey !== s.publicKey) fail(403, 'key_mismatch');
      const publicKey = s?.publicKey || body.publicKey;
      const { key, keyHash } = deliveryKey(publicKey);
      if (body.archiveId) {
        if (!s || !archive) fail(403, 'archive_session_required');
        let record;
        try { record = await archive.authorize(body.archiveId, s.wallet); } catch { fail(403, 'not_authorized'); }
        let raw;
        try {
          raw = await kms.decrypt(b64(record.wrappedKey));
          if (raw.length !== 32) fail(503, 'key_unavailable');
          const wrappedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, raw).toString('base64');
          return { wrappedKey, downloadUrl: await objects.downloadUrl(record.objectKey, record.versionId), ciphertextHash: record.ciphertextHash, id: record.id, version: 1, expiresIn: 60 };
        } finally { raw?.fill(0); }
      }
      const state = await chain.snapshot(body.auction.toLowerCase(), keyHash);
      if (state.chainId !== config.chainId || state.factory !== factory || !state.member || state.version !== 1 || !hex32(state.id) || !hex32(state.ciphertextHash)) fail(403, 'untrusted_auction');
      const record = await store.get('payload:' + state.id);
      if (!record?.ready || !record.versionId || record.wallet !== state.seller || record.ciphertextHash !== state.ciphertextHash || record.factory !== factory) fail(409, 'payload_unavailable');
      const wallet = s?.wallet;
      const isSeller = s ? wallet === state.seller : state.sellerKeyHash === keyHash;
      const hasWinner = state.winner !== '0x' + '0'.repeat(40);
      const matchesWinner = hasWinner && (s ? wallet === state.winner : state.winnerKeyHash === keyHash);
      const settled = state.closed && state.ended;
      // The hint selects a status message only. It never authorizes key release.
      const hint = !s && address(body.walletHint) ? body.walletHint.toLowerCase() : null;
      if (!isSeller && !settled && (matchesWinner || (hint && hint !== state.seller))) fail(409, 'awaiting_confirmation');
      if (!isSeller && !(matchesWinner && settled)) {
        if (hint === state.seller || (settled && hasWinner && hint === state.winner)) fail(409, 'delivery_key_recovery_required');
        fail(403, 'not_authorized');
      }
      let raw;
      try {
        raw = await kms.decrypt(b64(record.wrappedKey));
        if (raw.length !== 32) fail(503, 'key_unavailable');
        const wrappedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, raw).toString('base64');
        return { wrappedKey, downloadUrl: await objects.downloadUrl(record.objectKey, record.versionId), ciphertextHash: record.ciphertextHash, id: record.id, version: 1, expiresIn: 60 };
      } finally { raw?.fill(0); }
    }
    fail(404, 'not_found');
  }
  return async event => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' };
    const origin = event.headers?.origin || event.headers?.Origin;
    const requestId = event.requestContext?.requestId || randomBytes(8).toString('hex');
    try {
      if (!origins.has(origin)) fail(403, 'origin_denied');
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'authorization,content-type';
      headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
      const method = event.requestContext?.http?.method || event.httpMethod;
      if (method === 'OPTIONS') return { statusCode: 204, headers, body: '' };
      if (event.body && (event.isBase64Encoded || Buffer.byteLength(event.body) > 16384)) fail(413, 'body_too_large');
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { fail(400, 'invalid_json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json');
      const result = await route(event, origin, method, event.rawPath || event.path, body);
      if (method === 'POST' && (event.rawPath || event.path) === '/release') console.log(JSON.stringify({
        _aws: { Timestamp: now(), CloudWatchMetrics: [{ Namespace: 'MarketplaceProtected', Dimensions: [['Service']], Metrics: [{ Name: 'Releases', Unit: 'Count' }] }] },
        Service: config.serviceName || 'protected', Releases: 1, requestId,
      }));
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    } catch (e) {
      // Aggregate EMF only: do not log request data, wallet identity, or exceptions.
      if (!e.status || e.status >= 500) console.log(JSON.stringify({ _aws: { Timestamp: now(), CloudWatchMetrics: [{ Namespace: 'MarketplaceProtected', Dimensions: [['Service']], Metrics: [{ Name: 'Failures', Unit: 'Count' }] }] }, Service: config.serviceName || 'protected', Failures: 1 }));
      return { statusCode: e.status || 503, headers, body: JSON.stringify({ error: e.status ? e.message : 'service_unavailable', requestId }) };
    }
  };
}
module.exports = { createService, hash, deliveryKey };
