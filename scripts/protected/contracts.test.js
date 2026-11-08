const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const ganache = require("ganache");
const Web3 = require("web3");
const { compileContracts } = require("./compile");

let artifacts;
let provider;
let web3;
let accounts;
const hash = (value) => web3.utils.sha3(value);
const send = (method, from, value = "0") => method.send({ from, value, gas: 14000000 });
const reject = (method, from, value = "0") => assert.rejects(send(method, from, value));

before(async () => {
  artifacts = compileContracts({ includeLegacy: true, extraSources: {
    "Recipients.sol": { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;
interface IAuction {
  function contributeWithKey(bytes32) external payable;
  function finalizeAuctionIfNeeded() external;
  function withdrawRefund() external;
}
interface IFactory {
  function createEncryptedCampaign(uint256,bytes32,bytes32,bytes32,string memory,uint256) external;
}
contract Recipient {
  bool public rejectPayment;
  bool public attack;
  bool public reentered;
  address public target;
  function configure(address auction, bool rejectValue, bool attackValue) external {
    target = auction; rejectPayment = rejectValue; attack = attackValue;
  }
  function create(address factory, bytes32 nonce) external {
    IFactory(factory).createEncryptedCampaign(10,nonce,bytes32(uint256(1)),bytes32(uint256(2)),"recipient",1);
  }
  function bid(address auction) external payable {
    IAuction(auction).contributeWithKey{value:msg.value}(bytes32(uint256(3)));
  }
  function refund() external { IAuction(target).withdrawRefund(); }
  receive() external payable {
    require(!rejectPayment,"Reject payment");
    if(attack) {
      (bool ok,) = target.call(abi.encodeWithSignature("finalizeAuctionIfNeeded()"));
      (bool refundOk,) = target.call(abi.encodeWithSignature("withdrawRefund()"));
      reentered = ok || refundOk;
    }
  }
}` },
  } });
  provider = ganache.provider({
    logging: { quiet: true },
    wallet: { deterministic: true, totalAccounts: 10 },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: { blockGasLimit: 30000000 },
  });
  web3 = new Web3(provider);
  accounts = await web3.eth.getAccounts();
});
after(async () => { if (provider) await provider.disconnect(); });

async function deploy(artifact) {
  return new web3.eth.Contract(artifact.abi).deploy({ data: `0x${artifact.evm.bytecode.object}` })
    .send({ from: accounts[0], gas: 20000000 });
}
async function fresh() {
  const contracts = artifacts["ProtectedCampaign.sol"];
  return deploy(contracts.ProtectedCampaignFactory);
}
async function create(factory, { seller = accounts[1], nonce = hash("nonce"), minimum = 50 } = {}) {
  const receipt = await send(factory.methods.createEncryptedCampaign(minimum, nonce,
    hash("ciphertext"), hash("seller-key"), "Public description", 1), seller);
  const address = receipt.events.AuctionCreated.returnValues.campaignAddress;
  return { receipt, campaign: new web3.eth.Contract(artifacts["ProtectedCampaign.sol"].ProtectedCampaign.abi, address) };
}
async function expire() {
  await provider.request({ method: "evm_increaseTime", params: [61] });
  await provider.request({ method: "evm_mine", params: [] });
}

test("ABI has no plaintext creation or getData; legacy summaries contain empty payload", async () => {
  const contracts = artifacts["ProtectedCampaign.sol"];
  assert.ok(!contracts.ProtectedCampaignFactory.abi.some((item) => item.name === "createCampaign"));
  assert.ok(!contracts.ProtectedCampaign.abi.some((item) => item.name === "getData"));
  const factory = await fresh();
  const { campaign } = await create(factory);
  assert.equal(await campaign.methods.dataForSell().call(), "");
  const summary = await campaign.methods.getSummary().call();
  assert.equal(summary[5], "");
  assert.equal(summary[6], "Public description");
  assert.equal((await campaign.methods.getListSummary().call())[5], summary[6]);
  assert.equal(await factory.methods.getBudget(accounts[9]).call(), "2000");
  const payload = await campaign.methods.getEncryptedPayload().call();
  const expected = web3.utils.keccak256(web3.eth.abi.encodeParameters(
    ["uint256", "address", "address", "bytes32"], [1337, factory.options.address, accounts[1], hash("nonce")]));
  assert.equal(payload[0], "1");
  assert.equal(payload[1], expected);
  assert.equal(payload[2], hash("ciphertext"));
});

test("seller-bound nonce cannot replay; copied nonce cannot hijack payload; invalid creation rolls back", async () => {
  const factory = await fresh();
  const { campaign: first } = await create(factory);
  await assert.rejects(create(factory));
  const { campaign: second } = await create(factory, { seller: accounts[2] });
  assert.notEqual(await first.methods.payloadId().call(), await second.methods.payloadId().call());
  const zero = `0x${"0".repeat(64)}`;
  const nonce = hash("invalid-inputs");
  const method = (minimum, n, encryptedHash, key, desc, duration) =>
    factory.methods.createEncryptedCampaign(minimum, n, encryptedHash, key, desc, duration);
  for (const args of [
    [0, nonce, hash("c"), hash("k"), "desc", 1],
    [1, zero, hash("c"), hash("k"), "desc", 1],
    [1, nonce, zero, hash("k"), "desc", 1],
    [1, nonce, hash("c"), zero, "desc", 1],
    [1, nonce, hash("c"), hash("k"), "", 1],
    [1, nonce, hash("c"), hash("k"), "desc", 0],
    [1, nonce, hash("c"), hash("k"), "desc", 31],
  ]) await reject(method(...args), accounts[1]);
  await create(factory, { nonce });
});

test("bid authorization, stale bids, budget failure and expiry roll back delivery-key changes", async () => {
  const factory = await fresh();
  const { campaign } = await create(factory);
  const a = accounts[2];
  const b = accounts[3];
  const keyA = hash("key-a");
  await reject(campaign.methods.contribute(), a, "50");
  await reject(campaign.methods.contributeWithKey(`0x${"0".repeat(64)}`), a, "50");
  await reject(campaign.methods.contributeWithKey(keyA), accounts[1], "50");
  await reject(campaign.methods.contributeWithKey(keyA), a, "49");
  await send(campaign.methods.contributeWithKey(keyA), a, "50");
  await reject(campaign.methods.contributeWithKey(hash("bad-key")), a, "0");
  assert.equal(await campaign.methods.deliveryKeyHash(a).call(), keyA);
  await reject(campaign.methods.contributeWithKey(hash("b")), b, "50");
  await reject(campaign.methods.contributeWithKey(hash("b")), b, "2001");
  assert.equal(await factory.methods.getBudget(a).call(), "1950");
  assert.equal(await campaign.methods.highestBidder().call(), a);
  assert.equal(await campaign.methods.deliveryKeyHash(b).call(), `0x${"0".repeat(64)}`);
  await expire();
  await reject(campaign.methods.contributeWithKey(hash("expired")), a, "1");
  assert.equal(await campaign.methods.deliveryKeyHash(a).call(), keyA);
});

test("cumulative bids/outbids/finalization/refunds preserve existing budget-at-bid rules", async () => {
  const factory = await fresh();
  const { campaign } = await create(factory);
  const [seller, a, b] = accounts.slice(1, 4);
  await send(campaign.methods.contributeWithKey(hash("a")), a, "50");
  await send(campaign.methods.contributeWithKey(hash("b")), b, "60");
  assert.equal(await factory.methods.getBudget(a).call(), "2000");
  assert.equal(await factory.methods.getBudget(b).call(), "1940");
  await send(campaign.methods.contributeWithKey(hash("a2")), a, "20");
  await send(campaign.methods.contribute(), a, "10");
  assert.equal(await campaign.methods.highestBid().call(), "80");
  assert.equal(await factory.methods.getBudget(a).call(), "1920");
  assert.equal(await factory.methods.getBudget(b).call(), "2000");
  const ledger = await campaign.methods.getBidLedgerAt(2).call();
  assert.equal(ledger.cumulativeBid, "70");
  assert.equal(ledger.budgetBefore, "2000");
  assert.equal(ledger.budgetAfter, "1930");
  await reject(campaign.methods.finalizeAuctionIfNeeded(), b);
  await reject(campaign.methods.withdrawRefund(), b);
  await expire();
  const sellerBefore = BigInt(await web3.eth.getBalance(seller));
  await send(campaign.methods.finalizeAuctionIfNeeded(), accounts[0]);
  assert.equal(BigInt(await web3.eth.getBalance(seller)) - sellerBefore, 80n);
  assert.equal(await factory.methods.getBudget(seller).call(), "2080");
  assert.equal(await campaign.methods.closed().call(), true);
  await reject(campaign.methods.finalizeAuctionIfNeeded(), b);
  await reject(campaign.methods.withdrawRefund(), a);
  await send(campaign.methods.processRefunds(10), accounts[0]);
  assert.equal(await campaign.methods.getBid(b).call(), "0");
  assert.equal(await web3.eth.getBalance(campaign.options.address), "0");
  await reject(campaign.methods.withdrawRefund(), b);
  await reject(factory.methods.changeBudget(b, 1, true), b);
});

test("no bids closes safely with no winner and no payment", async () => {
  const factory = await fresh();
  const { campaign } = await create(factory);
  await expire();
  await send(factory.methods.checkEndedAuctionsRange(0, 5), accounts[0]);
  assert.equal(await campaign.methods.closed().call(), true);
  assert.equal(await campaign.methods.highestBidder().call(), `0x${"0".repeat(40)}`);
  assert.equal(await factory.methods.getBudget(accounts[1]).call(), "2000");
});

test("hostile seller payment rolls back; reentry cannot double pay; other auctions still finalize", async () => {
  const factory = await fresh();
  const recipient = await deploy(artifacts["Recipients.sol"].Recipient);
  await send(recipient.methods.create(factory.options.address, hash("hostile-seller")), accounts[0]);
  const addresses = await factory.methods.getDeployedCampaigns().call();
  const campaign = new web3.eth.Contract(artifacts["ProtectedCampaign.sol"].ProtectedCampaign.abi, addresses[0]);
  await send(recipient.methods.configure(campaign.options.address, true, false), accounts[0]);
  await send(campaign.methods.contributeWithKey(hash("bidder")), accounts[2], "50");
  const { campaign: healthy } = await create(factory, { nonce: hash("healthy") });
  await expire();
  await send(factory.methods.checkEndedAuctionsRange(0, 10), accounts[0]);
  assert.equal(await healthy.methods.closed().call(), true);
  assert.equal(await campaign.methods.closed().call(), false);
  assert.equal(await campaign.methods.getBid(accounts[2]).call(), "50");
  await send(recipient.methods.configure(campaign.options.address, false, true), accounts[0]);
  await send(campaign.methods.finalizeAuctionIfNeeded(), accounts[0]);
  assert.equal(await recipient.methods.reentered().call(), false);
  assert.equal(await web3.eth.getBalance(recipient.options.address), "50");
  assert.equal(await factory.methods.getBudget(recipient.options.address).call(), "2050");
});

test("rejected refunds remain claimable; successful refunds cannot be reentered", async () => {
  const factory = await fresh();
  const { campaign } = await create(factory);
  const recipient = await deploy(artifacts["Recipients.sol"].Recipient);
  await send(recipient.methods.configure(campaign.options.address, true, false), accounts[0]);
  await send(recipient.methods.bid(campaign.options.address), accounts[0], "50");
  await send(campaign.methods.contributeWithKey(hash("b")), accounts[3], "60");
  await expire();
  await send(campaign.methods.finalizeAuctionIfNeeded(), accounts[0]);
  await reject(campaign.methods.processRefunds(10), accounts[0]);
  assert.equal(await campaign.methods.getBid(recipient.options.address).call(), "50");
  assert.equal(await campaign.methods.nextRefundIndex().call(), "0");
  await send(recipient.methods.configure(campaign.options.address, false, true), accounts[0]);
  await send(recipient.methods.refund(), accounts[0]);
  assert.equal(await recipient.methods.reentered().call(), false);
  assert.equal(await web3.eth.getBalance(recipient.options.address), "50");
  await reject(recipient.methods.refund(), accounts[0]);
});

test("gas measurements compare protected and legacy with identical compiler settings", async (t) => {
  const factoryArtifact = artifacts["ProtectedCampaign.sol"].ProtectedCampaignFactory;
  const deployment = new web3.eth.Contract(factoryArtifact.abi)
    .deploy({ data: `0x${factoryArtifact.evm.bytecode.object}` });
  const deploymentEstimate = await deployment.estimateGas({ from: accounts[0], gas: 16000000 });
  let deploymentReceipt;
  const factory = await deployment.send({ from: accounts[0], gas: 16000000 })
    .on("receipt", (receipt) => { deploymentReceipt = receipt; });
  assert.ok(deploymentEstimate < 16777216);
  assert.ok(deploymentReceipt.gasUsed < 16777216);
  const protectedCreate = await create(factory);
  const protectedBid = await send(protectedCreate.campaign.methods.contributeWithKey(hash("gas")), accounts[2], "50");
  const legacyFactory = await deploy(artifacts["Campaign.sol"].CampaignFactory);
  const legacyCreate = await send(legacyFactory.methods.createCampaign(50, "secret dataset", "Public description", 1), accounts[1]);
  const legacyAddresses = await legacyFactory.methods.getDeployedCampaigns().call();
  const legacy = new web3.eth.Contract(artifacts["Campaign.sol"].Campaign.abi, legacyAddresses[0]);
  const legacyBid = await send(legacy.methods.contribute(), accounts[2], "50");
  t.diagnostic(JSON.stringify({ factoryDeploymentGas: deploymentReceipt.gasUsed,
    factoryEstimatedGas: deploymentEstimate, protectedCreateGas: protectedCreate.receipt.gasUsed,
    legacyCreateGas: legacyCreate.gasUsed, protectedBidGas: protectedBid.gasUsed, legacyBidGas: legacyBid.gasUsed }));
  assert.ok(protectedBid.gasUsed <= legacyBid.gasUsed + 35000, "Key registration adds at most one storage slot plus checks");
  assert.ok(protectedCreate.receipt.gasUsed < 10000000);
});
