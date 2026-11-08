#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const Web3 = require('web3');
const { address, archiveIdentity, assertPinnedBlock, assertSameArchivedContent, readClosedSnapshot, importSnapshot } = require('./archiveCore');
const campaignAbi = require('../../src/real_ethereum/build/Campaign.json').abi;
const factoryAbi = require('../../src/real_ethereum/build/CampaignFactory.json').abi;

function parseArgs(argv) {
  const result = { execute: false, confirmations: 12, limit: 100, chain: '11155111' };
  const options = new Set(['rpc', 'source-factory', 'target-factory', 'block', 'manifest',
    'checkpoint', 'adapter', 'profile', 'confirmations', 'limit', 'chain', 'aws-account']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (argv[i] === '--execute') result.execute = true;
    else if (argv[i] === '--dry-run') result.execute = false;
    else if (argv[i] === '--reuse-verified') result.reuseVerified = true;
    else if (options.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else throw new Error(`Unknown or missing argument: ${argv[i]}`);
  }
  if (!result.rpc || !result['source-factory']) throw new Error('--rpc and --source-factory are required');
  address(result['source-factory']);
  for (const key of ['confirmations', 'limit']) {
    result[key] = Number(result[key]);
    if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'confirmations' ? 12 : 1)) {
      throw new Error(`Invalid --${key}`);
    }
  }
  if (result.block && !/^\d+$/.test(result.block)) throw new Error('--block must be an integer');
  if (!/^\d+$/.test(result.chain)) throw new Error('--chain must be an integer');
  if (result.execute) {
    for (const key of ['adapter', 'target-factory', 'manifest', 'checkpoint', 'aws-account']) {
      if (!result[key]) throw new Error(`--execute requires --${key}`);
    }
    address(result['target-factory']);
    if (!/^\d{12}$/.test(result['aws-account'])) throw new Error('Invalid AWS account');
    if (path.resolve(result.manifest) === path.resolve(result.checkpoint)) throw new Error('Manifest and checkpoint must be different files');
  }
  return result;
}

function readJson(file) {
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function atomicJson(file, data) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, absolute);
}

function createSource(web3) {
  return {
    getBlock: (number) => web3.eth.getBlock(number),
    isCampaign: (factory, auction, block) => new web3.eth.Contract(factoryAbi, factory)
      .methods.isCampaign(auction).call({}, block),
    async readAuction(auction, block) {
      const contract = new web3.eth.Contract(campaignAbi, auction);
      const summary = await contract.methods.getSummary().call({}, block);
      return {
        factory: await contract.methods.factory().call({}, block),
        closed: await contract.methods.closed().call({}, block),
        seller: summary[3], winner: summary[7], highestBid: summary[4], payload: summary[5],
        minimum: summary[0], description: summary[6], endTime: summary[9],
      };
    },
  };
}

async function loadTarget(options) {
  const args = ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'];
  if (options.profile) args.push('--profile', options.profile);
  const identity = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (identity.Account !== options['aws-account'] || !/^arn:aws:/.test(identity.Arn)) {
    throw new Error('AWS caller does not match explicitly approved account');
  }
  const module = await import(pathToFileURL(path.resolve(options.adapter)).href);
  const create = module.createArchiveAdminAdapter || module.default?.createArchiveAdminAdapter;
  if (typeof create !== 'function') throw new Error('Missing administrative archive adapter');
  const target = await create({ identity, profile: options.profile, region: 'us-east-1' });
  if (target?.authKind !== 'aws-iam' || !['getEncryptionConfig', 'lookupArchive', 'importArchive']
    .every((method) => typeof target[method] === 'function')) {
    throw new Error('Archive import requires an IAM-authenticated administrative adapter');
  }
  return target;
}

async function run(options, client) {
  const web3 = client || new Web3(new Web3.providers.HttpProvider(options.rpc, { timeout: 20000 }));
  const chainId = String(await web3.eth.getChainId());
  if (chainId !== options.chain) throw new Error('Wrong source chain');
  const sourceFactory = address(options['source-factory']);
  const saved = readJson(options.manifest);
  const head = await web3.eth.getBlockNumber();
  const number = saved?.block?.number ?? options.block ?? head - options.confirmations;
  if (options.block && String(options.block) !== String(number)) throw new Error('Manifest uses a different block');
  if (Number(number) < 0 || Number(number) > head - options.confirmations) throw new Error('Snapshot lacks required confirmations');
  const source = createSource(web3);
  const block = await source.getBlock(number);
  if (!block?.hash) throw new Error('Snapshot block unavailable');
  if (saved && (saved.version !== 1 || saved.chainId !== chainId || saved.factory !== sourceFactory ||
      saved.block.hash.toLowerCase() !== block.hash.toLowerCase())) throw new Error('Manifest source mismatch');
  const factory = new web3.eth.Contract(factoryAbi, sourceFactory);
  const campaigns = await factory.methods.getDeployedCampaigns().call({}, block.number);
  if (new Set(campaigns.map(address)).size !== campaigns.length) throw new Error('Duplicate source campaigns');
  if (campaigns.length > options.limit) throw new Error('Source exceeds --limit; explicitly raise it to inspect all campaigns');
  const checkpoint = readJson(options.checkpoint) || { version: 1, entries: {} };
  if (checkpoint.version !== 1 || !checkpoint.entries || typeof checkpoint.entries !== 'object') throw new Error('Invalid checkpoint');
  // Resolve administrative dependencies before collecting legacy plaintext on execute.
  const target = options.execute ? await loadTarget(options) : null;
  const originals = new Map();
  if (target?.lookupArchives) {
    const confirmed = new Map();
    const ids = options.reuseVerified ? campaigns.map(auction => archiveIdentity(chainId, sourceFactory, auction)) : Object.keys(checkpoint.entries);
    for (let offset = 0; offset < ids.length; offset += 50) {
      const page = ids.slice(offset, offset + 50);
      const result = await target.lookupArchives(page);
      if (!Array.isArray(result?.receipts) || result.receipts.length !== page.length) throw new Error('Invalid remote checkpoint batch');
      page.forEach((id, index) => confirmed.set(id, result.receipts[index]));
      if (options.reuseVerified) {
        if (!Array.isArray(result.metadata) || result.metadata.length !== page.length) throw new Error('Original archive metadata is required');
        page.forEach((id, index) => { if (result.receipts[index]) originals.set(id, result.metadata[index]); });
      }
    }
    const lookup = target.lookupArchive;
    target.lookupArchive = id => confirmed.has(id) ? Promise.resolve(confirmed.get(id)) : lookup(id);
  }
  const crypto = options.execute ? await import('../../src/protected/crypto.mjs') : null;
  if (options.execute && typeof crypto.sealText !== 'function') throw new Error('Shared encryption module is unavailable');
  const manifest = {
    version: 1, chainId, factory: sourceFactory,
    block: { number: String(block.number), hash: block.hash, timestamp: String(block.timestamp) },
    archives: [], skippedOpen: 0,
  };
  // Pin the restart cursor before the first remote write.
  if (options.execute) atomicJson(options.manifest, manifest);
  const metadata = new Array(campaigns.length);
  let next = 0;
  let failure;
  const inspect = async () => {
    while (!failure && next < campaigns.length) {
      const index = next++;
      let snapshot;
      try {
        for (let attempt = 0; ; attempt++) {
          try { snapshot = await readClosedSnapshot(source, campaigns[index], block, sourceFactory, chainId); break; }
          catch (error) { if (attempt >= 2) throw error; await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
        }
        if (!snapshot) { manifest.skippedOpen++; continue; }
        const original = originals.get(snapshot.metadata.archiveId);
        if (original) {
          assertSameArchivedContent(original, snapshot.metadata);
          await assertPinnedBlock(source, { number: original.source.blockNumber, hash: original.source.blockHash });
          snapshot.metadata = original;
        }
        metadata[index] = snapshot.metadata;
        if (options.execute) {
          const receipt = await importSnapshot({
            snapshot, target, sealText: crypto.sealText,
            context: { chainId, factory: address(options['target-factory']), seller: snapshot.metadata.seller,
              nonce: snapshot.metadata.archiveId },
            checkpointEntry: checkpoint.entries[snapshot.metadata.archiveId],
          });
          checkpoint.entries[snapshot.metadata.archiveId] = receipt;
          atomicJson(options.checkpoint, checkpoint);
        }
      } catch (error) { failure = Object.assign(new Error('Archive operation failed'), { code: error.code || 'archive_snapshot_read', auction: campaigns[index] }); }
      finally { if (snapshot) snapshot.payload = null; }
    }
  };
  // Two bounded readers/importers; a failed operation stops new assignments.
  await Promise.all([inspect(), inspect()]);
  manifest.archives = metadata.filter(Boolean);
  if (failure) { if (options.manifest) atomicJson(options.manifest, manifest); throw failure; }
  await assertPinnedBlock(source, block);
  if (options.manifest) atomicJson(options.manifest, manifest);
  console.log(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run',
    block: manifest.block, eligible: manifest.archives.length, skippedOpen: manifest.skippedOpen }));
  return manifest;
}

if (require.main === module) {
  // Contract/provider errors can contain return values (including historical plaintext).
  run(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(JSON.stringify({ failed: true, failureKind: /^[a-z_]+$/.test(error.code || '') ? error.code : 'archive_configuration', auction: error.auction }));
    process.exitCode = 1;
  });
}
module.exports = { parseArgs, createSource, run };
