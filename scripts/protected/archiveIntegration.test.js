const { test } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const Web3 = require('web3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileContracts } = require('./compile');
const { createSource, run, parseArgs } = require('./archiveImport');
const { readClosedSnapshot, importSnapshot, ZERO } = require('./archiveCore');

test('real legacy contract archive preserves state and seals payload for offline-seller delivery', { timeout: 90000 }, async () => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 11155111 },
    miner: { blockGasLimit: 30000000 } });
  try {
    const web3 = new Web3(provider);
    const [seller, winner] = await web3.eth.getAccounts();
    const artifacts = compileContracts({ includeLegacy: true })['Campaign.sol'];
    const artifact = artifacts.CampaignFactory;
    const factory = await new web3.eth.Contract(artifact.abi).deploy({ data: `0x${artifact.evm.bytecode.object}` })
      .send({ from: seller, gas: 14000000 });
    const secret = 'LEGACY_PRIVATE_ARCHIVE_MARKER_123';
    await factory.methods.createCampaign(10, secret, 'archive integration', 1).send({ from: seller, gas: 10000000 });
    const [auction] = await factory.methods.getDeployedCampaigns().call();
    const campaignArtifact = artifacts.Campaign;
    const campaign = new web3.eth.Contract(campaignArtifact.abi, auction);
    await campaign.methods.contribute().send({ from: winner, value: '10', gas: 1000000 });
    const source = createSource(web3);
    let block = await web3.eth.getBlock('latest');
    assert.equal(await readClosedSnapshot(source, auction, block, factory.options.address, 11155111), null);
    await provider.request({ method: 'evm_increaseTime', params: [61] });
    await provider.request({ method: 'evm_mine', params: [] });
    await campaign.methods.finalizeAuctionIfNeeded().send({ from: seller, gas: 1000000 });
    block = await web3.eth.getBlock('latest');
    const beforeHeight = await web3.eth.getBlockNumber();
    const beforeBudget = await factory.methods.getBudget(winner).call();
    const record = await readClosedSnapshot(source, auction, block, factory.options.address, 11155111);
    assert.equal(record.metadata.winner, winner.toLowerCase());
    assert.notEqual(record.metadata.winner, ZERO);
    assert.equal(record.payload, secret);
    const crypto = await import('../../src/protected/crypto.mjs');
    const kms = await crypto.generateDeliveryKey();
    const delivery = await crypto.generateDeliveryKey();
    let stored;
    const receipt = await importSnapshot({ snapshot: record, sealText: crypto.sealText,
      context: { chainId: 11155111, factory: factory.options.address, seller, nonce: record.metadata.archiveId },
      target: {
        getEncryptionConfig: async () => ({ publicKey: await crypto.exportPublicKey(kms.publicKey) }),
        lookupArchive: async () => null,
        importArchive: async (request) => {
          assert.equal(JSON.stringify(request).includes(secret), false);
          stored = request;
          return { archiveId: request.idempotencyKey, snapshotHash: request.metadata.snapshotHash,
            ciphertextHash: request.ciphertextHash, recordId: 'test-s3-version' };
        },
      } });
    const raw = await crypto.unwrapKey(stored.wrappedKey, kms.privateKey);
    const delivered = await crypto.wrapKey(raw, delivery.publicKey);
    const received = await crypto.unwrapKey(delivered, delivery.privateKey);
    assert.equal(await crypto.openEnvelope(stored.envelope, received), secret);
    assert.equal(receipt.archiveId, record.metadata.archiveId);
    assert.equal(await web3.eth.getBlockNumber(), beforeHeight);
    assert.equal(await factory.methods.getBudget(winner).call(), beforeBudget);
    assert.equal(await campaign.methods.dataForSell().call(), secret, 'Historical plaintext cannot be erased');
    for (let i = 0; i < 12; i++) await provider.request({ method: 'evm_mine', params: [] });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-integration-'));
    const manifestFile = path.join(directory, 'manifest.json');
    try {
      const options = parseArgs(['--rpc', 'http://unused.invalid', '--source-factory', factory.options.address,
        '--manifest', manifestFile]);
      const manifest = await run(options, web3);
      assert.equal(manifest.archives.length, 1);
      assert.equal(fs.readFileSync(manifestFile, 'utf8').includes(secret), false);
      await provider.request({ method: 'evm_mine', params: [] });
      const resumed = await run(options, web3);
      assert.equal(resumed.block.hash, manifest.block.hash);
      await assert.rejects(run({ ...options, chain: '1' }, web3), /Wrong source chain/);
    } finally {
      if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);
      fs.rmdirSync(directory);
    }
    raw.fill(0); received.fill(0);
  } finally { await provider.disconnect(); }
});
