'use strict';
const { createHash, createDecipheriv } = require('node:crypto');
const digest = value => '0x' + createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const valid32 = x => /^0x[\da-f]{64}$/.test(x || '');
function createArchive({ config, store, objects, kms, chain }) {
  return {
    admin: async event => {
      if (event.requestContext || event.httpMethod || event.rawPath) throw new Error('IAM invocation required');
      if (event.adminAction === 'config') return { publicKey: await kms.publicKey() };
      if (event.adminAction === 'lookup') {
        if (!valid32(event.archiveId)) throw new Error('Invalid archive ID');
        return (await store.get('archive:' + event.archiveId))?.receipt || null;
      }
      if (event.adminAction === 'lookup-many') {
        if (!Array.isArray(event.archiveIds) || !event.archiveIds.length || event.archiveIds.length > 50 || event.archiveIds.some(id => !valid32(id)) || new Set(event.archiveIds).size !== event.archiveIds.length) throw new Error('Invalid archive lookup batch');
        const records = [];
        for (let index = 0; index < event.archiveIds.length; index += 5) {
          records.push(...await Promise.all(event.archiveIds.slice(index, index + 5).map(async id => await store.get('archive:' + id))));
        }
        return { receipts: records.map(record => record?.receipt || null), metadata: records.map(record => record?.metadata || null) };
      }
      if (event.adminAction !== 'import') throw new Error('Unknown admin action');
      const b = event.body;
      const m = b?.metadata;
      if (!m?.source || !valid32(m.archiveId) || b.idempotencyKey !== m.archiveId) throw new Error('Invalid archive');
      const prior = await store.get('archive:' + m.archiveId);
      if (prior) {
        if (prior.receipt.snapshotHash !== m.snapshotHash) throw new Error('Archive conflict');
        return prior.receipt;
      }
      const expected = await chain.legacySnapshot(m.source);
      if (stable(expected) !== stable(m)) throw new Error('Snapshot mismatch');
      const e = b.envelope;
      const context = { chainId: config.chainId, factory: config.factory, seller: m.seller, nonce: m.archiveId };
      if (stable({ ...b.context, chainId: Number(b.context?.chainId) }) !== stable(context) || stable(e?.context) !== stable(context) || e.version !== 1 || digest(Buffer.from(JSON.stringify(e))) !== b.ciphertextHash) throw new Error('Envelope mismatch');
      if (Object.keys(e).sort().join(',') !== 'ciphertext,context,iv,version' || Buffer.from(e.iv, 'base64').length !== 12 || Buffer.from(e.ciphertext, 'base64').length > 1048592 || Buffer.from(e.ciphertext, 'base64').length < 17) throw new Error('Invalid envelope');
      let raw, plain;
      try {
        raw = await kms.decrypt(Buffer.from(b.wrappedKey, 'base64'));
        if (raw.length !== 32) throw new Error('Invalid wrapped key');
        // Archive-only: already-public legacy content must match the original hash.
        // New protected uploads never decrypt their content server-side.
        const encrypted = Buffer.from(e.ciphertext, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', raw, Buffer.from(e.iv, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify({ version: 1, ...context })));
        decipher.setAuthTag(encrypted.subarray(-16));
        plain = decipher.update(encrypted.subarray(0, -16));
        const tail = decipher.final();
        if (tail.length || digest(plain) !== m.payloadHash) { tail.fill(0); throw new Error('Archive plaintext mismatch'); }
        tail.fill(0);
      } finally { raw?.fill(0); plain?.fill(0); }
      const objectKey = 'payloads/archive-' + m.archiveId + '.json';
      const versionId = await objects.write(objectKey, Buffer.from(JSON.stringify(e)));
      if (!versionId) throw new Error('Versioned object required');
      const receipt = { archiveId: m.archiveId, snapshotHash: m.snapshotHash, ciphertextHash: b.ciphertextHash, recordId: 'archive:' + m.archiveId };
      const item = { kind: 'archive', metadata: m, receipt, objectKey, versionId, wrappedKey: b.wrappedKey, ready: true, id: m.archiveId, ciphertextHash: b.ciphertextHash };
      try { await store.create(receipt.recordId, item); }
      catch {
        const winner = await store.get(receipt.recordId);
        if (winner?.receipt.snapshotHash !== m.snapshotHash) throw new Error('Archive conflict');
        return winner.receipt;
      }
      return receipt;
    },
    list: async cursor => {
      const page = await store.listArchives(cursor);
      const items = Array.isArray(page) ? page : page.items;
      return { archives: items.map(r => ({ ...r.metadata, id: r.id, recordId: r.receipt.recordId, ciphertextHash: r.ciphertextHash })), nextCursor: page.nextCursor || null };
    },
    authorize: async (id, wallet) => {
      if (!valid32(id) || !wallet) throw new Error('Archive session required');
      const r = await store.get('archive:' + id);
      if (!r?.ready || !r.versionId) throw new Error('Missing archive');
      const current = await chain.legacySnapshot(r.metadata.source, { currentState: true });
      if (stable(current) !== stable(r.metadata)) throw new Error('Archive no longer canonical');
      if (wallet !== current.seller && (wallet !== current.winner || /^0x0{40}$/.test(current.winner))) throw new Error('Not authorized');
      return r;
    }
  };
}
module.exports = { createArchive, stable, digest };
