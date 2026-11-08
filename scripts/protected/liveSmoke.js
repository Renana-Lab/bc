const fs = require('node:fs');
const path = require('node:path');
const Web3 = require('web3');
const { Wallet } = require('ethers');
require('dotenv').config({ quiet: true });
const dir = path.resolve(__dirname, '../../artifacts/backend/protected');
const file = path.join(dir, 'live-smoke-private.json');
const origin = 'https://main.df7mlebpdd7v7.amplifyapp.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const crypto = await import('../../src/protected/crypto.mjs');
  const base = process.env.PROTECTED_API_URL;
  if (!base?.startsWith('https://')) throw new Error('PROTECTED_API_URL required');
  const w = new Web3(process.env.PROTECTED_RPC_URL || process.env.RPC_URL);
  if (Number(await w.eth.getChainId()) !== 11155111) throw new Error('Sepolia only');
  const call = async (route, body, token) => {
    const response = await fetch(base.replace(/\/$/, '') + route, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.error || 'API failed'); error.status = response.status; error.route = route; throw error; }
    return value;
  };
  const config = await call('/config');
  if (config.chainId !== 11155111) throw new Error('Wrong API chain');
  const auth = async (signer, delivery) => {
    const publicKey = await crypto.exportPublicKey(delivery.publicKey);
    const c = await call('/challenge', { wallet: signer.address, publicKey });
    const signature = await signer._signTypedData(c.typedData.domain, c.typedData.types, c.typedData.message);
    return call('/session', { challengeId: c.challengeId, signature });
  };
  const factoryArtifact = require('../../src/real_ethereum/build/ProtectedCampaignFactory.json');
  const campaignArtifact = require('../../src/real_ethereum/build/ProtectedCampaign.json');
  if (process.argv.includes('--prepare')) {
    if (fs.existsSync(file)) throw new Error('An experiment already exists; do not create duplicates');
    const key = process.env.DEPLOY_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.AUTO_FINALIZE_PRIVATE_KEY;
    const seller = new Wallet(key);
    w.eth.accounts.wallet.add(key);
    const winner = Wallet.createRandom();
    const delivery = await crypto.generateDeliveryKey();
    const session = await auth(seller, delivery);
    const text = `PROTECTED-LIVE-${globalThis.crypto.randomUUID()}`;
    const nonce = crypto.randomNonce();
    const sealed = await crypto.sealText(text, { chainId: 11155111, factory: config.factory, seller: seller.address, nonce }, config.publicKey);
    const envelopeBody = JSON.stringify(sealed.envelope);
    const upload = await call('/uploads', { nonce, ciphertextHash: sealed.ciphertextHash, wrappedKey: sealed.wrappedKey, envelopeBytes: Buffer.byteLength(envelopeBody) }, session.token);
    const put = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: envelopeBody });
    if (!put.ok) throw new Error('Upload failed');
    await call(`/uploads/${upload.id}/complete`, {}, session.token);
    const f = new w.eth.Contract(factoryArtifact.abi, config.factory);
    const method = f.methods.createEncryptedCampaign(50, nonce, sealed.ciphertextHash, await crypto.fingerprintPublicKey(await crypto.exportPublicKey(delivery.publicKey)), 'Protected verification dataset', 1);
    const calldata = method.encodeABI();
    if (calldata.includes(Buffer.from(text).toString('hex'))) throw new Error('Plaintext in calldata');
    const estimate = await method.estimateGas({ from: seller.address });
    const receipt = await method.send({ from: seller.address, gas: Math.ceil(Number(estimate) * 1.15) });
    const auction = receipt.events.AuctionCreated.returnValues.campaignAddress;
    const state = { auction, factory: config.factory, winnerPrivateKey: winner.privateKey, expectedDigest: await crypto.sha256(text), createTransaction: receipt.transactionHash };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    const funding = { from: seller.address, to: winner.address, value: w.utils.toWei('0.05', 'ether') };
    await w.eth.sendTransaction({ ...funding, gas: Math.ceil(Number(await w.eth.estimateGas(funding)) * 1.15) });
    w.eth.accounts.wallet.add(winner.privateKey);
    const winKey = await crypto.generateDeliveryKey();
    const campaign = new w.eth.Contract(campaignArtifact.abi, auction);
    const bid = campaign.methods.contributeWithKey(await crypto.fingerprintPublicKey(await crypto.exportPublicKey(winKey.publicKey)));
    const bidReceipt = await bid.send({ from: winner.address, value: '100', gas: Math.ceil(Number(await bid.estimateGas({ from: winner.address, value: '100' })) * 1.15) });
    state.bidTransaction = bidReceipt.transactionHash;
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    console.log(JSON.stringify({ prepared: true, auction, createTransaction: receipt.transactionHash, bidTransaction: bidReceipt.transactionHash, markerAbsentFromCalldata: true }));
    return;
  }
  const state = JSON.parse(fs.readFileSync(file));
  if (state.factory.toLowerCase() !== config.factory.toLowerCase()) throw new Error('Factory mismatch');
  // New delivery keys represent a second device. No seller signing key is used.
  const delivery = await crypto.generateDeliveryKey();
  const winner = new Wallet(state.winnerPrivateKey);
  const session = await auth(winner, delivery);
  let release;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { release = await call('/release', { auction: state.auction }, session.token); break; }
    catch (error) { if (![403, 409, 503].includes(error.status)) throw error; await sleep(20000); }
  }
  if (!release) throw new Error('Finalization or confirmed release did not become available');
  const response = await fetch(release.downloadUrl);
  if (!response.ok) throw new Error('Download failed');
  const envelope = await response.json();
  const raw = await crypto.unwrapKey(release.wrappedKey, delivery.privateKey);
  try {
    const text = await crypto.openEnvelope(envelope, raw, envelope.context, release.ciphertextHash);
    if (await crypto.sha256(text) !== state.expectedDigest) throw new Error('Decrypted result mismatch');
    const transaction = await w.eth.getTransaction(state.createTransaction);
    if (transaction.input.toLowerCase().includes(Buffer.from(text).toString('hex'))) throw new Error('Plaintext in calldata');
    const campaign = new w.eth.Contract(campaignArtifact.abi, state.auction);
    const summary = await campaign.methods.getSummary().call();
    if (summary[5] !== '' || JSON.stringify(envelope).includes(text)) throw new Error('Plaintext exposed by public reads');
  } finally { raw.fill(0); }
  const timings = [];
  for (let index = 0; index < 10; index++) {
    const started = Date.now();
    await call('/release', { auction: state.auction }, session.token);
    timings.push(Date.now() - started);
  }
  const p95 = [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1];
  const loser = Wallet.createRandom();
  const loserSession = await auth(loser, await crypto.generateDeliveryKey());
  let denied = false;
  try { await call('/release', { auction: state.auction }, loserSession.token); }
  catch (error) { denied = error.status === 403; }
  if (!denied) throw new Error('Losing wallet was not denied');
  const publicKey = await crypto.exportPublicKey(delivery.publicKey);
  const replay = await call('/challenge', { wallet: winner.address, publicKey });
  const signature = await winner._signTypedData(replay.typedData.domain, replay.typedData.types, replay.typedData.message);
  await call('/session', { challengeId: replay.challengeId, signature });
  let replayDenied = false;
  try { await call('/session', { challengeId: replay.challengeId, signature }); }
  catch (error) { replayDenied = error.status === 401; }
  let substitutionDenied = false;
  try { await call('/release', { auction: state.auction, publicKey: await crypto.exportPublicKey((await crypto.generateDeliveryKey()).publicKey) }, session.token); }
  catch (error) { substitutionDenied = error.status === 403; }
  const nonce = crypto.randomNonce();
  const probe = await crypto.sealText('Dummy encrypted upload boundary probe', { chainId: 11155111, factory: config.factory, seller: winner.address, nonce }, config.publicKey);
  const body = JSON.stringify(probe.envelope);
  const upload = await call('/uploads', { nonce, ciphertextHash: probe.ciphertextHash, wrappedKey: probe.wrappedKey, envelopeBytes: Buffer.byteLength(body) + 1 }, session.token);
  const mismatchedPut = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  const uploadSizeDenied = mismatchedPut.status === 403;
  if (!replayDenied || !substitutionDenied || !uploadSizeDenied) throw new Error('Live security boundary failed');
  const report = { passed: true, auction: state.auction, newDeviceWinnerDecrypted: true, losingWalletDenied: true, sellerNotUsedForRelease: true, markerAbsentFromPublicReads: true, securityProbes: { replayDenied, substitutionDenied, uploadSizeDenied }, releaseTiming: { samplesMs: timings, p95Ms: p95, targetMs: 2000, targetMet: p95 <= 2000 }, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'live-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(JSON.stringify({ failed: true, reason: /^(Sepolia only|Wrong API chain|Factory mismatch|Decrypted result mismatch|Losing wallet was not denied|Finalization or confirmed release did not become available)$/.test(error.message) ? error.message : 'Live smoke failed; inspect service diagnostics without printing secrets', status: error.status, route: error.route })); process.exitCode = 1; });
