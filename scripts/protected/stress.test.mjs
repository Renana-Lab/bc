import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { allocateCycleCandidates } from '../../src/botnet/cyclePlanner.mjs';
const require = createRequire(import.meta.url);
const ganache = require('ganache');
const Web3 = require('web3');
const { compileContracts } = require('./compile');

test('protected stress: 50 live auctions, 100 bot wallets, 1000 indexed historical records', async t => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 1337, hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 151 }, miner: { blockGasLimit: 30000000 } });
  t.after(() => provider.disconnect());
  const w = new Web3(provider);
  const accounts = await w.eth.getAccounts();
  const artifacts = compileContracts()['ProtectedCampaign.sol'];
  const f = await new w.eth.Contract(artifacts.ProtectedCampaignFactory.abi).deploy({ data: '0x' + artifacts.ProtectedCampaignFactory.evm.bytecode.object }).send({ from: accounts[0], gas: 15000000 });
  const hash = w.utils.sha3('public-key-fingerprint-fixture');
  const active = [];
  // Controlled write concurrency: each creation uses a distinct seller wallet.
  for (let offset = 0; offset < 50; offset += 5) {
    const created = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
      const index = offset + i;
      const receipt = await f.methods.createEncryptedCampaign(50, w.utils.sha3(`nonce-${index}`), w.utils.sha3(`ciphertext-${index}`), hash, `Dummy ${index}`, 30).send({ from: accounts[index + 1], gas: 14000000 });
      const address = receipt.events.AuctionCreated.returnValues.campaignAddress;
      const c = new w.eth.Contract(artifacts.ProtectedCampaign.abi, address);
      const summary = await c.methods.getSummary().call();
      assert.equal(summary[5], '');
      return { address, manager: accounts[index + 1], minimumContribution: '50', highestBid: '0', highestBidder: '0x' + '0'.repeat(40), approversCount: 0, endTimeSec: Number(await c.methods.endTime().call()), closed: false, campaign: c };
    }));
    active.push(...created);
  }
  const history = Array.from({ length: 1000 }, (_, i) => ({ address: '0x' + (i + 100000).toString(16).padStart(40, '0'), closed: true, endTimeSec: 1 }));
  const indexed = [...history, ...active];
  const snapshot = indexed.filter(a => !a.closed);
  const nowSec = Number((await w.eth.getBlock('latest')).timestamp);
  const bots = accounts.slice(51).map((wallet, i) => ({ id: String(i), wallet, budgetWei: 2000n, strategy: { maxBidsPerCycle: 1, maxBidWei: '2000', maxMinContributionWei: '2000', outbidByWei: '10', minSecondsBeforeEnd: 20, skipIfWinning: true } }));
  const plan = allocateCycleCandidates({ bots, auctions: snapshot, nowSec, reservePerSlot: 0, random: () => 0.5 });
  const targets = bots.flatMap(bot => plan.assignments[bot.id].primary.map(a => ({ bot, auction: a })));
  assert.equal(targets.length, 50);
  assert.equal(new Set(targets.map(x => x.auction.address)).size, 50);
  assert.ok(plan.candidatesEvaluated <= 100 * 50 * 2);
  for (let offset = 0; offset < targets.length; offset += 5) {
    await Promise.all(targets.slice(offset, offset + 5).map(async ({ bot, auction }) => {
      const c = new w.eth.Contract(artifacts.ProtectedCampaign.abi, auction.address);
      await c.methods.contributeWithKey(hash).send({ from: bot.wallet, value: '50', gas: 14000000 });
      assert.equal(await c.methods.highestBidder().call(), bot.wallet);
      assert.equal(await c.methods.deliveryKeyHash(bot.wallet).call(), hash);
      assert.equal(await f.methods.getBudget(bot.wallet).call(), '1950');
    }));
  }
  console.log(JSON.stringify({ protectedStress: true, realCreatedAuctions: 50, registeredBotWallets: 100, indexedHistoricalFixtures: 1000, minedDistinctBids: targets.length, candidatesEvaluated: plan.candidatesEvaluated }));
});
