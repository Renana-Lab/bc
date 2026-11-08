import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  sealText, generateDeliveryKey, exportPublicKey, fingerprintPublicKey,
  unwrapKey, wrapKey, openEnvelope, sha256,
} from '../../src/protected/crypto.mjs';

const require = createRequire(import.meta.url);
const ganache = require('ganache');
const Web3 = require('web3');
const { compileContracts } = require('./compile');

test('local milestone: real chain, disconnected seller, authenticated winner, encrypted key delivery', async (t) => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 1337, hardfork: 'shanghai' },
    wallet: { deterministic: true }, miner: { blockGasLimit: 30000000 } });
  t.after(() => provider.disconnect());
  const web3 = new Web3(provider);
  const accounts = await web3.eth.getAccounts();
  const [owner, seller, winner, loser] = accounts;
  const artifacts = compileContracts()['ProtectedCampaign.sol'];
  const factory = await new web3.eth.Contract(artifacts.ProtectedCampaignFactory.abi)
    .deploy({ data: `0x${artifacts.ProtectedCampaignFactory.evm.bytecode.object}` })
    .send({ from: owner, gas: 20000000 });

  // KMS is simulated only at the asymmetric key boundary; no AWS integration is claimed here.
  const kms = await generateDeliveryKey();
  const kmsPublic = await exportPublicKey(kms.publicKey);
  const sellerDevice = await generateDeliveryKey();
  const sellerHash = await fingerprintPublicKey(await exportPublicKey(sellerDevice.publicKey));
  const context = { chainId: 1337, factory: factory.options.address, seller,
    nonce: web3.utils.sha3('milestone-nonce') };
  const marker = 'PROTECTED-NEW-PLAINTEXT-MARKER-7391';
  const payload = await sealText(marker, context, kmsPublic);
  assert.equal(JSON.stringify(payload).includes(marker), false);
  const receipt = await factory.methods.createEncryptedCampaign(50, context.nonce,
    payload.ciphertextHash, sellerHash, 'Public milestone description', 1)
    .send({ from: seller, gas: 14000000 });
  const campaign = new web3.eth.Contract(artifacts.ProtectedCampaign.abi,
    receipt.events.AuctionCreated.returnValues.campaignAddress);
  const payloadId = await campaign.methods.payloadId().call();

  const winnerDevice = await generateDeliveryKey();
  const winnerPublic = await exportPublicKey(winnerDevice.publicKey);
  await campaign.methods.contributeWithKey(await fingerprintPublicKey(winnerPublic))
    .send({ from: winner, value: '60', gas: 2000000 });
  assert.equal(await campaign.methods.deliveryKeyHash(winner).call(), await fingerprintPublicKey(winnerPublic));
  const creationTransaction = await web3.eth.getTransaction(receipt.transactionHash);
  const markerHex = Buffer.from(marker).toString('hex');
  assert.equal(creationTransaction.input.includes(markerHex), false);
  assert.equal(JSON.stringify(receipt.events).includes(markerHex), false);
  assert.equal((await campaign.methods.getSummary().call())[5], '');
  for (let slot = 0; slot < 32; slot++) {
    assert.equal((await web3.eth.getStorageAt(campaign.options.address, slot)).includes(markerHex), false);
  }

  const signingKeys = provider.getInitialAccounts();
  const consumed = new Set();
  let sequence = 0;
  const challenge = (address, publicKey) => ({ address, publicKey, nonce: `local-${sequence++}`,
    chainId: 1337, factory: factory.options.address, campaign: campaign.options.address, payloadId });
  const sign = item => web3.eth.accounts.sign(JSON.stringify(item), signingKeys[item.address.toLowerCase()].secretKey).signature;
  // This executable adapter proves the eligibility boundaries with real state; production uses EIP-712.
  const release = async (item, signature) => {
    const signer = web3.eth.accounts.recover(JSON.stringify(item), signature);
    assert.equal(signer.toLowerCase(), item.address.toLowerCase(), 'Signature does not match requester');
    assert.equal(consumed.has(item.nonce), false, 'Replay');
    assert.equal(item.campaign, campaign.options.address);
    assert.equal(item.payloadId, payloadId);
    assert.equal(await factory.methods.isCampaign(item.campaign).call(), true);
    const head = await web3.eth.getBlockNumber();
    const pinned = head - 12;
    assert.ok(pinned >= 0, 'Waiting for confirmations');
    const closed = await campaign.methods.closed().call({}, pinned);
    const chainWinner = await campaign.methods.highestBidder().call({}, pinned);
    assert.ok(closed, 'Not finalized with 12 confirmations');
    assert.equal(chainWinner.toLowerCase(), signer.toLowerCase(), 'Requester is not winner');
    assert.notEqual(chainWinner.toLowerCase(), `0x${'0'.repeat(40)}`);
    const metadata = await campaign.methods.getEncryptedPayload().call({}, pinned);
    assert.equal(metadata[1], item.payloadId);
    assert.equal(metadata[2], await sha256(JSON.stringify(payload.envelope)));
    consumed.add(item.nonce);
    const raw = await unwrapKey(payload.wrappedKey, kms.privateKey);
    try { return await wrapKey(raw, item.publicKey); }
    finally { raw.fill(0); }
  };

  const early = challenge(winner, winnerPublic);
  await assert.rejects(release(early, sign(early)));
  // Seller makes no further calls after upload/creation. Any account can finalize.
  await provider.request({ method: 'evm_increaseTime', params: [61] });
  await provider.request({ method: 'evm_mine', params: [] });
  await campaign.methods.finalizeAuctionIfNeeded().send({ from: owner, gas: 2000000 });
  const unconfirmed = challenge(winner, winnerPublic);
  await assert.rejects(release(unconfirmed, sign(unconfirmed)));
  for (let i = 0; i < 12; i++) await provider.request({ method: 'evm_mine', params: [] });

  const losingDevice = await generateDeliveryKey();
  const losingPublic = await exportPublicKey(losingDevice.publicKey);
  const denied = challenge(loser, losingPublic);
  await assert.rejects(release(denied, sign(denied)), /not winner/);
  const swap = challenge(winner, winnerPublic);
  const beforeSwapSignature = sign(swap);
  await assert.rejects(release({ ...swap, publicKey: losingPublic }, beforeSwapSignature), /Signature/);

  // New device requires only another wallet proof, not the seller's key or original device.
  const recoveryDevice = await generateDeliveryKey();
  const recoveryPublic = await exportPublicKey(recoveryDevice.publicKey);
  const request = challenge(winner, recoveryPublic);
  const signature = sign(request);
  const delivered = await release(request, signature);
  await assert.rejects(release(request, signature), /Replay/);
  await assert.rejects(unwrapKey(delivered, losingDevice.privateKey));
  const aes = await unwrapKey(delivered, recoveryDevice.privateKey);
  try {
    assert.equal(await openEnvelope(payload.envelope, aes, context, payload.ciphertextHash), marker);
    await assert.rejects(openEnvelope({ ...payload.envelope, context: { ...context, seller: loser } }, aes));
    await assert.rejects(openEnvelope(payload.envelope, aes, context, `0x${'0'.repeat(64)}`));
  } finally { aes.fill(0); }
  t.diagnostic('Real Ganache business state + WebCrypto. KMS and delivery API are local test adapters, not deployed AWS.');
});
