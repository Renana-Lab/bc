const { createHash } = require('node:crypto');

const LABEL = 'Encrypted copy of previously public information';
const ZERO = '0x0000000000000000000000000000000000000000';
const address = (value) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value))) throw new Error('Invalid address');
  return value.toLowerCase();
};
const digest = (value) => `0x${createHash('sha256').update(value).digest('hex')}`;
const stableJson = (value) => JSON.stringify(value, (_, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  }
  return item;
});
const archiveIdentity = (chainId, factory, auction) =>
  digest(`${String(chainId)}:${address(factory)}:${address(auction)}`);

function assertSameArchivedContent(original, observed) {
  const { snapshotHash, ...unsigned } = original;
  if (digest(stableJson(unsigned)) !== snapshotHash) throw new Error('Invalid original archive snapshot hash');
  const content = metadata => {
    const { snapshotHash: ignored, source, ...fields } = metadata;
    return { ...fields, source: { chainId: source.chainId, factory: source.factory, auction: source.auction } };
  };
  if (stableJson(content(original)) !== stableJson(content(observed))) throw new Error('Closed archive content changed');
}

async function assertPinnedBlock(source, block) {
  const current = await source.getBlock(block.number);
  if (!current || current.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error('Pinned block changed; aborting archive import');
  }
}

async function readClosedSnapshot(source, auction, block, factory, chainId) {
  auction = address(auction);
  factory = address(factory);
  await assertPinnedBlock(source, block);
  if (!(await source.isCampaign(factory, auction, block.number))) {
    throw new Error('Auction is not registered in the source factory');
  }
  const state = await source.readAuction(auction, block.number);
  if (address(state.factory) !== factory) throw new Error('Campaign factory mismatch');
  const ended = BigInt(state.endTime) <= BigInt(block.timestamp);
  if (state.closed !== true || !ended) return null;
  const seller = address(state.seller);
  if (seller === ZERO) throw new Error('Missing seller');
  const winner = address(state.winner);
  if ((BigInt(state.highestBid) > 0n) !== (winner !== ZERO)) {
    throw new Error('Inconsistent winner/payment state');
  }
  if (typeof state.payload !== 'string' || !state.payload.length) {
    throw new Error('Legacy payload missing; no plaintext fallback is allowed');
  }
  const metadata = {
    version: 1,
    archiveId: archiveIdentity(chainId, factory, auction),
    label: LABEL,
    source: {
      chainId: String(chainId), factory, auction,
      blockNumber: String(block.number), blockHash: block.hash.toLowerCase(),
    },
    seller, winner, closed: true,
    endTime: String(state.endTime), highestBid: String(state.highestBid),
    minimum: String(state.minimum), description: String(state.description),
    payloadHash: digest(Buffer.from(state.payload, 'utf8')),
  };
  metadata.snapshotHash = digest(stableJson(metadata));
  await assertPinnedBlock(source, block);
  return { metadata, payload: state.payload };
}

function validateCheckpointEntry(entry, metadata) {
  if (entry.archiveId !== metadata.archiveId || entry.snapshotHash !== metadata.snapshotHash ||
      !/^0x[0-9a-f]{64}$/i.test(entry.ciphertextHash || '') || !entry.recordId) {
    throw new Error('Checkpoint conflicts with pinned source snapshot');
  }
}

async function importSnapshot({ snapshot, target, sealText, context, checkpointEntry }) {
  const { metadata, payload } = snapshot;
  if (checkpointEntry) {
    validateCheckpointEntry(checkpointEntry, metadata);
    const receipt = await target.lookupArchive(metadata.archiveId);
    if (!receipt || receipt.snapshotHash !== metadata.snapshotHash ||
        receipt.ciphertextHash !== checkpointEntry.ciphertextHash ||
        receipt.recordId !== checkpointEntry.recordId) {
      throw new Error('Checkpoint cannot be confirmed by administrative archive service');
    }
    return checkpointEntry;
  }
  const existing = await target.lookupArchive(metadata.archiveId);
  if (existing) {
    validateCheckpointEntry(existing, metadata);
    return existing;
  }
  const { publicKey } = await target.getEncryptionConfig();
  if (!publicKey) throw new Error('Administrative service did not provide KMS public key');
  const sealed = await sealText(payload, context, publicKey);
  const receipt = await target.importArchive({
    idempotencyKey: metadata.archiveId,
    metadata, context, envelope: sealed.envelope,
    wrappedKey: sealed.wrappedKey, ciphertextHash: sealed.ciphertextHash,
  });
  validateCheckpointEntry(receipt, metadata);
  if (receipt.ciphertextHash !== sealed.ciphertextHash) throw new Error('Archive receipt hash mismatch');
  return receipt;
}

module.exports = {
  LABEL, ZERO, address, digest, stableJson, archiveIdentity,
  assertPinnedBlock, readClosedSnapshot, validateCheckpointEntry, importSnapshot,
  assertSameArchivedContent,
};
