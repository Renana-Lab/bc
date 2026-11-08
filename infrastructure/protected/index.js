'use strict';
const { createService } = require('./service');
let initialized;
async function consumeChallenge(ddb, UpdateCommand, TableName, pk, epoch) {
  try {
    await ddb.send(new UpdateCommand({ TableName, Key: { pk }, UpdateExpression: 'SET #used = :yes', ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#used) AND #expires > :now', ExpressionAttributeNames: { '#used': 'consumed', '#expires': 'expiresAt' }, ExpressionAttributeValues: { ':yes': true, ':now': epoch } }));
    return true;
  } catch (error) { if (error.name === 'ConditionalCheckFailedException') return false; throw error; }
}
exports.consumeChallenge = consumeChallenge;
async function initialize() {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const { KMSClient, GetPublicKeyCommand, DecryptCommand } = require('@aws-sdk/client-kms');
  const { JsonRpcProvider, Contract, AbiCoder, keccak256, verifyTypedData, FetchRequest } = require('ethers');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
  const s3 = new S3Client({ maxAttempts: 2, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const kmsClient = new KMSClient({ maxAttempts: 2 });
  const TableName = process.env.TABLE_NAME;
  const Bucket = process.env.BUCKET_NAME;
  const KeyId = process.env.KMS_KEY_ID;
  const factory = process.env.FACTORY_ADDRESS.toLowerCase();
  const chainId = Number(process.env.CHAIN_ID || 11155111);
  let rpc = process.env.RPC_URL;
  if (process.env.RPC_SECRET_ARN) {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    rpc = (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.RPC_SECRET_ARN }))).SecretString;
  }
  const urls = rpc.split(',').map(x => x.trim());
  for (const url of urls) if (!/^https:\/\//.test(url)) throw new Error('HTTPS RPC required');
  const providers = urls.map(url => {
    const request = new FetchRequest(url); request.timeout = 3000;
    return new JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  });
  const store = {
    get: async pk => (await ddb.send(new GetCommand({ TableName, Key: { pk }, ConsistentRead: true }))).Item,
    create: (pk, value) => ddb.send(new PutCommand({ TableName, Item: { pk, ...value }, ConditionExpression: 'attribute_not_exists(pk)' })),
    consume: (pk, epoch) => consumeChallenge(ddb, UpdateCommand, TableName, pk, epoch),
    complete: async (pk, versionId) => {
      try { await ddb.send(new UpdateCommand({ TableName, Key: { pk }, UpdateExpression: 'SET ready = :yes, versionId = :version', ConditionExpression: 'attribute_exists(pk) AND ready = :no', ExpressionAttributeValues: { ':yes': true, ':no': false, ':version': versionId } })); }
      catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
    },
    listArchives: cursor => archivePager(cursor)
  };
  const archivePager = require('./pagination').createArchivePager({
    get: pk => store.get(pk),
    query: ({ limit, exclusiveStartKey }) => ddb.send(new QueryCommand({ TableName, IndexName: 'kind-index', KeyConditionExpression: 'kind = :kind', ExpressionAttributeValues: { ':kind': 'archive' }, Limit: limit, ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}) }))
  });
  const objects = {
    uploadUrl: (key, length) => getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType: 'application/json', ContentLength: length }), { expiresIn: 300, signableHeaders: new Set(['content-length', 'content-type']) }),
    write: async (key, bytes) => (await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: 'application/json' }))).VersionId,
    read: async key => {
      const response = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!response.ContentLength || response.ContentLength > 1400000) { response.Body?.destroy?.(); throw new Error('Invalid object length'); }
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      return { bytes, version: response.VersionId };
    },
    downloadUrl: (key, version) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key, VersionId: version, ResponseCacheControl: 'no-store' }), { expiresIn: 60 })
  };
  let publicKey;
  const kms = {
    publicKey: async () => {
      if (!publicKey) publicKey = Buffer.from((await kmsClient.send(new GetPublicKeyCommand({ KeyId }))).PublicKey).toString('base64');
      return publicKey;
    },
    decrypt: async blob => Buffer.from((await kmsClient.send(new DecryptCommand({ KeyId, CiphertextBlob: blob, EncryptionAlgorithm: 'RSAES_OAEP_SHA_256' }))).Plaintext)
  };
  const campaignAbi = [
    'function factory() view returns (address)', 'function manager() view returns (address)',
    'function highestBidder() view returns (address)', 'function closed() view returns (bool)',
    'function endTime() view returns (uint256)', 'function getEncryptedPayload() view returns (uint8,bytes32,bytes32)',
    'function deliveryKeyHash(address) view returns (bytes32)'
  ];
  const chain = {
    legacySnapshot: async (source, { currentState = false } = {}) => {
      const { stable, digest } = require('./archive');
      const allowed = new Set((process.env.LEGACY_FACTORIES || '').split(',').map(x => x.toLowerCase()));
      if (!source || String(source.chainId) !== String(chainId) || !allowed.has(source.factory) || !/^0x[\da-f]{40}$/.test(source.auction) || !/^\d+$/.test(source.blockNumber) || !/^0x[\da-f]{64}$/.test(source.blockHash)) throw new Error('Untrusted legacy source');
      for (const provider of providers) {
        let phase = 'chain';
        try {
          if (Number(BigInt(await provider.send('eth_chainId', []))) !== chainId) throw new Error('Wrong legacy chain');
          phase = 'block';
          const number = Number(source.blockNumber);
          const head = Number(BigInt(await provider.send('eth_blockNumber', [])));
          if (!Number.isSafeInteger(number) || number < 0 || number > head - 12) throw new Error('Unconfirmed legacy block');
          const block = await provider.getBlock(number);
          if (!block || block.hash.toLowerCase() !== source.blockHash) throw new Error('Legacy block mismatch');
          // Imports prove the exact historical state. Previously verified, closed
          // records can revalidate immutable ownership at a fresh confirmed block.
          const readNumber = currentState ? head - 12 : number;
          const readBlock = readNumber === number ? block : await provider.getBlock(readNumber);
          if (!readBlock) throw new Error('Legacy verification block missing');
          phase = 'membership';
          const f = new Contract(source.factory, ['function isCampaign(address) view returns (bool)'], provider);
          if (!await f.isCampaign(source.auction, { blockTag: readNumber })) throw new Error('Foreign legacy auction');
          phase = 'fields';
          const c = new Contract(source.auction, ['function factory() view returns(address)', 'function closed() view returns(bool)', 'function getSummary() view returns(uint256,uint256,uint256,address,uint256,string,string,address,address[],uint256)'], provider);
          const fields = await Promise.all(['factory', 'closed', 'getSummary'].map(async name => {
            try { return await c[name]({ blockTag: readNumber }); }
            catch (error) {
              const message = String(error.info?.error?.message || error.shortMessage || '');
              const detail = /rate limit|too many|429|limit exceeded/i.test(message) ? 'capacity' : /trie|historical|state.*unavailable/i.test(message) ? 'historical-state' : /revert/i.test(message) ? 'revert' : 'rpc-failure';
              console.log(JSON.stringify({ operation: 'archive-field', field: name, failureKind: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'rpc_failure', detail }));
              throw error;
            }
          }));
          const summary = fields[2];
          if (fields[0].toLowerCase() !== source.factory || !fields[1] || summary[9] > BigInt(block.timestamp)) throw new Error('Legacy state mismatch');
          const metadata = { version: 1, archiveId: digest(`${chainId}:${source.factory}:${source.auction}`), label: 'Encrypted copy of previously public information', source, seller: summary[3].toLowerCase(), winner: summary[7].toLowerCase(), closed: true, endTime: String(summary[9]), highestBid: String(summary[4]), minimum: String(summary[0]), description: summary[6], payloadHash: digest(Buffer.from(summary[5], 'utf8')) };
          metadata.snapshotHash = digest(stable(metadata));
          phase = 'canonical';
          if ((await provider.getBlock(number))?.hash !== block.hash) throw new Error('Legacy canonical mismatch');
          if (readNumber !== number && (await provider.getBlock(readNumber))?.hash !== readBlock.hash) throw new Error('Legacy verification reorg');
          return metadata;
        } catch (error) {
          console.log(JSON.stringify({ operation: 'archive-verification', phase, failureKind: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'invalid_state' }));
        }
      }
      throw new Error('Legacy verification unavailable');
    },
    snapshot: async auction => {
      for (const provider of providers) {
        try {
          if (Number(BigInt(await provider.send('eth_chainId', []))) !== chainId) continue;
          const head = Number(BigInt(await provider.send('eth_blockNumber', [])));
          if (head < 12) continue;
          const blockTag = head - 12;
          const block = await provider.getBlock(blockTag);
          if (!block) continue;
          const c = new Contract(auction, campaignAbi, provider);
          const f = new Contract(factory, ['function isCampaign(address) view returns (bool)'], provider);
          const [member, actualFactory, seller, winner, closed, endTime, payload] = await Promise.all([
            f.isCampaign(auction, { blockTag }), c.factory({ blockTag }), c.manager({ blockTag }),
            c.highestBidder({ blockTag }), c.closed({ blockTag }), c.endTime({ blockTag }), c.getEncryptedPayload({ blockTag })
          ]);
          if (!member || actualFactory.toLowerCase() !== factory) return { chainId, factory: actualFactory.toLowerCase(), member: false };
          const [sellerKeyHash, winnerKeyHash] = await Promise.all([c.deliveryKeyHash(seller, { blockTag }), c.deliveryKeyHash(winner, { blockTag })]);
          // Confirm the pinned block is still canonical after the parallel read set.
          if ((await provider.getBlock(blockTag))?.hash !== block.hash) continue;
          return { chainId, factory, member, seller: seller.toLowerCase(), winner: winner.toLowerCase(), closed, ended: BigInt(block.timestamp) >= endTime, version: Number(payload[0]), id: payload[1].toLowerCase(), ciphertextHash: payload[2].toLowerCase(), sellerKeyHash: sellerKeyHash.toLowerCase(), winnerKeyHash: winnerKeyHash.toLowerCase() };
        } catch { /* Try another pinned provider; never use stale authorization. */ }
      }
      throw new Error('Chain verification unavailable');
    }
  };
  const config = { chainId, factory, origins: process.env.ALLOWED_ORIGINS.split(','), kmsKeyId: KeyId, finalizerConfigured: process.env.FINALIZER_CONFIGURED === 'true', serviceName: process.env.AWS_LAMBDA_FUNCTION_NAME };
  const archive = require('./archive').createArchive({ config, store, objects, kms, chain });
  const handler = createService({ config, store, objects, kms, chain, archive,
    verifyTypedData: (data, signature) => verifyTypedData(data.domain, data.types, data.message, signature),
    payloadId: (id, f, seller, nonce) => keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'address', 'bytes32'], [id, f, seller, nonce])) });
  return event => event.adminAction && !event.requestContext && !event.httpMethod && !event.rawPath ? archive.admin(event) : handler(event);
}
exports.handler = async event => {
  try {
    if (!initialized) initialized = initialize().catch(e => { initialized = undefined; throw e; });
    return await (await initialized)(event);
  } catch (error) {
    const reason = ({ 'Legacy verification unavailable': 'archive_chain_unavailable', 'Snapshot mismatch': 'archive_snapshot_mismatch', 'Archive plaintext mismatch': 'archive_content_mismatch', 'Envelope mismatch': 'archive_envelope_mismatch', 'Archive conflict': 'archive_conflict' })[error.message] || 'service_unavailable';
    console.log(JSON.stringify({ outcome: reason, failed: true }));
    return { statusCode: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: reason }) };
  }
};
