// Admin / hardening tests for CampaignFactory + Campaign clones against sapphire-localnet (docker).
// Nothing here touches a public chain.
//
//   docker run -it -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet
//   npm run sapphire:test        (or: node --test scripts/sapphire/admin.test.mjs)
//
// Set REQUIRE_LOCALNET=1 to fail (instead of skip) when the localnet is unreachable.
// Set PRINT_GAS=1 (default on) to print create-gas measurements.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  HDNodeWallet,
  JsonRpcProvider,
  ContractFactory,
  Contract,
  Mnemonic,
  ZeroAddress,
  parseEther,
} from "ethers";
import { wrapEthersSigner, wrapEthersProvider } from "@oasisprotocol/sapphire-ethers-v6";
import { buildSiweMessage, splitSignature } from "../../src/real_ethereum/siwe.mjs";

const require = createRequire(import.meta.url);
const compiledFactory = require("../../src/real_ethereum/build/CampaignFactory.json");
const compiledCampaign = require("../../src/real_ethereum/build/Campaign.json");
const solc = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/solc"));

const RPC_URL = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
const CHAIN_ID = 23293;
const DOMAIN = "localhost:3000";
const MNEMONIC =
  process.env.SAPPHIRE_LOCALNET_MNEMONIC ||
  "test test test test test test test test test test test junk";
const DEFAULT_BUDGET = 2000n;
const PAYLOAD = "ADMIN-TEST-PAYLOAD-c41d7e-do-not-leak";

const plain = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const reachable = await plain.getBlockNumber().then(() => true, () => false);
const skip = reachable ? false : `sapphire-localnet is not reachable at ${RPC_URL}`;
if (!reachable && process.env.REQUIRE_LOCALNET) throw new Error(skip);

const wallets = [];
const wallet = (index) => {
  wallets[index] ||= HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(plain);
  return wallets[index];
};
const signers = new Map();
const signerOf = (w) => {
  if (!signers.has(w.address)) signers.set(w.address, wrapEthersSigner(w));
  return signers.get(w.address);
};
const wrappedProvider = wrapEthersProvider(plain);

const attempt = async (promise) => {
  try {
    return { reverted: false, result: await promise };
  } catch (error) {
    return { reverted: true, error };
  }
};
const sendTx = async (promise) => (await promise).wait();
const assertReverts = async (promise, label) => {
  const outcome = await attempt(sendTx(promise));
  assert.equal(outcome.reverted, true, `${label} must revert`);
};
const parseEvents = (receipt, iface) =>
  receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const siweToken = async (factory, signer) => {
  const message = buildSiweMessage({
    domain: DOMAIN,
    address: signer.address,
    uri: `http://${DOMAIN}`,
    chainId: CHAIN_ID,
    now: new Date(Date.now() - 5000),
  });
  const sig = splitSignature(await signer.signMessage(message));
  return factory.login(message, sig);
};

// Test-only helper contract: a bidder / seller that can refuse to receive ETH.
const HELPER_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;
interface IC { function contribute() external payable; function withdrawRefund() external; function withdrawSellerPayment() external; }
interface IF { function createCampaign(uint256,string memory,string memory,uint256) external; }
contract Rejecter {
    bool public accept;
    function setAccept(bool v) external { accept = v; }
    function bid(address c) external payable { IC(c).contribute{value: msg.value}(); }
    function create(address f, uint256 m, string memory d, string memory desc, uint256 dur) external { IF(f).createCampaign(m, d, desc, dur); }
    function pullRefund(address c) external { IC(c).withdrawRefund(); }
    function pullSeller(address c) external { IC(c).withdrawSellerPayment(); }
    receive() external payable { require(accept, "rejected"); }
}`;
const compileHelper = () => {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Rejecter.sol": { content: HELPER_SOURCE } },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      })
    )
  );
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  return out.contracts["Rejecter.sol"].Rejecter;
};

const setup = async () => {
  // Make sure the extra accounts can pay gas (localnet funds only the first few).
  const funder = wallet(0);
  for (let i = 1; i <= 8; i += 1) {
    const w = wallet(i);
    if ((await plain.getBalance(w.address)) < parseEther("1")) {
      await (await funder.sendTransaction({ to: w.address, value: parseEther("5") })).wait();
    }
  }
};

const deployFactory = async (ownerWallet) => {
  const deployer = new ContractFactory(compiledFactory.abi, `0x${compiledFactory.evm.bytecode.object}`, signerOf(ownerWallet));
  const deployed = await deployer.deploy(DOMAIN, ownerWallet.address);
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  const startBlock = (await deployed.deploymentTransaction().wait()).blockNumber;
  const as = (runner) => new Contract(address, compiledFactory.abi, runner);
  return { address, startBlock, as, read: as(wrappedProvider), asWallet: (w) => as(signerOf(w)) };
};

const createAuction = async (fx, seller, { minimum = 1, payload = PAYLOAD, description = "desc", duration = 1 } = {}) => {
  const receipt = await sendTx(fx.asWallet(seller).createCampaign(minimum, payload, description, duration));
  const created = parseEvents(receipt, fx.read.interface).find((e) => e.name === "AuctionCreated");
  const address = created.args[0];
  const as = (runner) => new Contract(address, compiledCampaign.abi, runner);
  return { address, read: as(wrappedProvider), asWallet: (w) => as(signerOf(w)) };
};

test("admin role, limits, clones and hardening", { skip, timeout: 1_800_000 }, async (t) => {
  await setup();
  const owner = wallet(0);
  const admin2 = wallet(1);
  const seller = wallet(2);
  const bidderA = wallet(3);
  const bidderB = wallet(4);
  const outsider = wallet(5);

  const fx = await deployFactory(owner);
  const ownerFactory = fx.asWallet(owner);

  await t.test("constructor: owner is admin, zero owner rejected, no admin payload read in the ABI", async () => {
    assert.equal(await fx.read.owner(), owner.address);
    assert.equal(await fx.read.isAdmin(owner.address), true);
    assert.equal(await fx.read.isAdmin(outsider.address), false);
    assert.equal(compiledCampaign.abi.some((i) => i.name === "getDataAsAdmin"), false);
    const deployer = new ContractFactory(compiledFactory.abi, `0x${compiledFactory.evm.bytecode.object}`, signerOf(owner));
    const zero = await attempt(deployer.deploy(DOMAIN, ZeroAddress).then((c) => c.waitForDeployment()));
    assert.equal(zero.reverted, true, "zero owner must be rejected");
  });

  const live = await createAuction(fx, seller, { minimum: 10, duration: 5 });

  await t.test("every admin function reverts for a non-admin", async () => {
    const f = fx.asWallet(outsider);
    const calls = {
      resetAllBudgets: () => f.resetAllBudgets(500),
      setUserBudget: () => f.setUserBudget(bidderA.address, 100),
      setMinimum: () => f.setMinimum(live.address, 20),
      closeNow: () => f.closeNow(live.address),
      cancelAuction: () => f.cancelAuction(live.address, "no"),
      setHidden: () => f.setHidden(live.address, true),
      setDisabled: () => f.setDisabled(bidderA.address, true),
      setAllowSellerEdit: () => f.setAllowSellerEdit(false),
      addAdmin: () => f.addAdmin(outsider.address),
      removeAdmin: () => f.removeAdmin(admin2.address),
      transferOwnership: () => f.transferOwnership(outsider.address),
    };
    for (const [name, call] of Object.entries(calls)) await assertReverts(call(), name);
    // Campaign-level admin hooks are only callable by the factory.
    await assertReverts(live.asWallet(outsider).adminSetMinimum(5), "adminSetMinimum direct");
    await assertReverts(live.asWallet(outsider).adminCloseNow(), "adminCloseNow direct");
    await assertReverts(live.asWallet(outsider).adminCancel(), "adminCancel direct");
    // Budget hooks are only callable by campaigns.
    await assertReverts(f.holdBid(outsider.address, 1), "holdBid direct");
    await assertReverts(f.releaseBid(outsider.address, 1), "releaseBid direct");
    await assertReverts(f.settleBid(outsider.address, seller.address, 1), "settleBid direct");
    assert.equal(await live.read.minimumContribution(), 10n);
  });

  await t.test("owner manages admins; owner cannot be removed; ownership is 2-step", async () => {
    await sendTx(ownerFactory.addAdmin(admin2.address));
    assert.equal(await fx.read.isAdmin(admin2.address), true);
    await assertReverts(ownerFactory.addAdmin(admin2.address), "duplicate addAdmin");
    // an admin who is not the owner cannot manage admins
    await assertReverts(fx.asWallet(admin2).addAdmin(outsider.address), "admin addAdmin");
    // an admin can use admin functions
    await sendTx(fx.asWallet(admin2).setHidden(live.address, true));
    await sendTx(fx.asWallet(admin2).setHidden(live.address, false));

    await assertReverts(ownerFactory.removeAdmin(owner.address), "remove owner");
    const removed = await sendTx(ownerFactory.removeAdmin(admin2.address));
    assert.ok(parseEvents(removed, fx.read.interface).some((e) => e.name === "AdminRemoved"));
    assert.equal(await fx.read.isAdmin(admin2.address), false);

    await sendTx(ownerFactory.transferOwnership(admin2.address));
    assert.equal(await fx.read.owner(), owner.address, "owner unchanged until accepted");
    await assertReverts(fx.asWallet(outsider).acceptOwnership(), "wrong acceptor");
    await sendTx(fx.asWallet(admin2).acceptOwnership());
    assert.equal(await fx.read.owner(), admin2.address);
    assert.equal(await fx.read.isAdmin(admin2.address), true);
    // hand it back
    await sendTx(fx.asWallet(admin2).transferOwnership(owner.address));
    await sendTx(ownerFactory.acceptOwnership());
    assert.equal(await fx.read.owner(), owner.address);
    await sendTx(ownerFactory.removeAdmin(admin2.address));
  });

  await t.test("createCampaign limits and clone gas", async () => {
    const f = fx.asWallet(seller);
    const bytes = (n) => "x".repeat(n);
    await assertReverts(f.createCampaign(0, "p", "d", 1), "minimum 0");
    await assertReverts(f.createCampaign(1_000_000_001n, "p", "d", 1), "minimum too high");
    await assertReverts(f.createCampaign(1, "", "d", 1), "empty payload");
    await assertReverts(f.createCampaign(1, "p", "", 1), "empty description");
    await assertReverts(f.createCampaign(1, bytes(2001), "d", 1), "payload 2001 B");
    await assertReverts(f.createCampaign(1, "p", bytes(1201), 1), "description 1201 B");
    await assertReverts(f.createCampaign(1, "p", "d", 0), "duration 0");
    await assertReverts(f.createCampaign(1, "p", "d", 31), "duration 31");
    // boundaries are accepted
    await sendTx(f.createCampaign(1_000_000_000n, bytes(2000), bytes(1200), 30));

    // Real gasUsed (what is charged). eth_estimateGas on Sapphire overshoots creates by about 4x because of
    // the 63/64 rule around CREATE + the nested initialize call, so it is NOT reported here.
    const gas = {};
    for (const [label, size] of [["payload 1 B", 1], ["payload 300 B", 300], ["payload 2000 B", 2000]]) {
      gas[label] = (await sendTx(f.createCampaign(1, bytes(size), "d", 1))).gasUsed;
    }
    console.log("createCampaign gasUsed:", JSON.stringify(gas, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.ok(gas["payload 2000 B"] < 15_000_000n);
  });

  await t.test("clones: initialize only once; implementation is locked", async () => {
    const campaign = await createAuction(fx, seller);
    await assertReverts(campaign.asWallet(seller).initialize(1, "p", "d", seller.address, 9999999999, seller.address), "re-initialize clone (non-factory)");
    await assertReverts(campaign.asWallet(outsider).initialize(1, "p", "d", outsider.address, 9999999999, fx.address), "spoofed factory");
    const impl = new Contract(await fx.read.implementation(), compiledCampaign.abi, signerOf(seller));
    await assertReverts(impl.initialize(1, "p", "d", seller.address, 9999999999, seller.address), "initialize implementation");
    assert.equal(await campaign.read.manager(), seller.address);
    assert.equal(await fx.read.isCampaign(campaign.address), true);
  });

  await t.test("setMinimum: preconditions, events, range", async () => {
    const a = await createAuction(fx, seller, { minimum: 10, duration: 5 });
    await assertReverts(ownerFactory.setMinimum(a.address, 0), "min 0");
    await assertReverts(ownerFactory.setMinimum(a.address, 1_000_000_001n), "min too high");
    await assertReverts(ownerFactory.setMinimum(outsider.address, 5), "not a campaign");
    const receipt = await sendTx(ownerFactory.setMinimum(a.address, 25));
    const ev = parseEvents(receipt, fx.read.interface).find((e) => e.name === "MinimumChanged");
    assert.deepEqual([ev.args[0], ev.args[1], ev.args[2], ev.args[3]], [a.address, 10n, 25n, owner.address]);
    assert.equal(await a.read.minimumContribution(), 25n);

    // a bid blocks edits (admin and seller)
    await sendTx(a.asWallet(bidderA).contribute({ value: 30 }));
    await assertReverts(ownerFactory.setMinimum(a.address, 5), "admin after bid");
    await assertReverts(a.asWallet(seller).sellerSetMinimum(5), "seller after bid");

    // ended (closeNow) and closed (cancelled) block edits
    const ended = await createAuction(fx, seller, { minimum: 10, duration: 5 });
    await sendTx(ownerFactory.closeNow(ended.address));
    await sleep(2500);
    await assertReverts(ownerFactory.setMinimum(ended.address, 5), "after end");
    await assertReverts(ended.asWallet(seller).sellerSetMinimum(5), "seller after end");
    const cancelled = await createAuction(fx, seller, { minimum: 10, duration: 5 });
    await sendTx(ownerFactory.cancelAuction(cancelled.address, "x"));
    await assertReverts(ownerFactory.setMinimum(cancelled.address, 5), "after cancel");
  });

  await t.test("seller edit-minimum: default on, only the seller, admin toggle", async () => {
    assert.equal(await fx.read.allowSellerEdit(), true);
    const a = await createAuction(fx, seller, { minimum: 10, duration: 5 });
    await assertReverts(a.asWallet(outsider).sellerSetMinimum(5), "non-seller");
    await assertReverts(a.asWallet(seller).sellerSetMinimum(0), "seller min 0");
    await assertReverts(a.asWallet(seller).sellerSetMinimum(1_000_000_001n), "seller min too high");
    const receipt = await sendTx(a.asWallet(seller).sellerSetMinimum(40));
    // the factory emits MinimumChanged for seller edits as well (by = seller)
    const ev = parseEvents(
      { logs: receipt.logs.filter((l) => l.address.toLowerCase() === fx.address.toLowerCase()) },
      fx.read.interface
    ).find((e) => e.name === "MinimumChanged");
    assert.deepEqual([ev.args[0], ev.args[1], ev.args[2], ev.args[3]], [a.address, 10n, 40n, seller.address]);
    assert.equal(await a.read.minimumContribution(), 40n);

    await sendTx(ownerFactory.setAllowSellerEdit(false));
    await assertReverts(a.asWallet(seller).sellerSetMinimum(50), "seller edit disabled");
    await sendTx(ownerFactory.setAllowSellerEdit(true));
    await sendTx(a.asWallet(seller).sellerSetMinimum(50));
    assert.equal(await a.read.minimumContribution(), 50n);
  });

  await t.test("closeNow ends the auction early; finalize then works; only the winner reads", async () => {
    const a = await createAuction(fx, seller, { minimum: 1, duration: 5 });
    await sendTx(a.asWallet(bidderA).contribute({ value: 100 }));
    const receipt = await sendTx(ownerFactory.closeNow(a.address));
    assert.ok(parseEvents(receipt, fx.read.interface).some((e) => e.name === "AuctionClosedEarly"));
    await sleep(2500);
    await assertReverts(a.asWallet(bidderB).contribute({ value: 200 }), "bid after closeNow");
    await sendTx(a.asWallet(outsider).finalizeAuctionIfNeeded());
    assert.equal(await a.read.closed(), true);
    assert.equal(await a.read.getDataWithToken(await siweToken(fx.read, bidderA)), PAYLOAD);
    // No admin path to the payload: neither the owner token nor the seller token can read.
    for (const w of [owner, seller, outsider]) {
      assert.equal((await attempt(a.read.getDataWithToken(await siweToken(fx.read, w)))).reverted, true);
    }
    assert.equal((await attempt(a.read.getDataWithToken("0x"))).reverted, true);
    await assertReverts(ownerFactory.closeNow(a.address), "closeNow on closed auction");
  });

  await t.test("cancel: leader refunded, seller not paid, payload unreadable, budgets restored", async () => {
    const heldBefore = await fx.read.heldBy(bidderA.address);
    const budgetABefore = await fx.read.getBudget(bidderA.address);
    const a = await createAuction(fx, seller, { minimum: 1, duration: 5 });
    await sendTx(a.asWallet(bidderB).contribute({ value: 60 }));
    await sendTx(a.asWallet(bidderA).contribute({ value: 100 }));
    assert.equal(await fx.read.heldBy(bidderA.address), heldBefore + 100n);
    assert.equal(await fx.read.getBudget(bidderA.address), budgetABefore - 100n);

    const sellerEth = await plain.getBalance(seller.address);
    const sellerBudget = await fx.read.getBudget(seller.address);

    await assertReverts(ownerFactory.cancelAuction(a.address, "x".repeat(501)), "note > 500 bytes");
    const receipt = await sendTx(ownerFactory.cancelAuction(a.address, "bad listing"));
    const ev = parseEvents(receipt, fx.read.interface).find((e) => e.name === "AuctionCancelled");
    assert.deepEqual([ev.args[0], ev.args[1], ev.args[2], ev.args[3]], [a.address, owner.address, "bad listing", true]);
    assert.equal(await a.read.closed(), true);
    assert.equal(await a.read.cancelled(), true);
    assert.equal(await fx.read.heldBy(bidderA.address), heldBefore);
    assert.equal(await fx.read.getBudget(bidderA.address), budgetABefore);

    assert.equal(await plain.getBalance(seller.address), sellerEth, "seller not paid");
    assert.equal(await fx.read.getBudget(seller.address), sellerBudget, "seller budget not credited");
    assert.equal(await plain.getBalance(a.address), 160n, "funds stay escrowed for pull refunds");

    await assertReverts(a.asWallet(outsider).finalizeAuctionIfNeeded(), "finalize cancelled");
    await assertReverts(a.asWallet(bidderB).contribute({ value: 500 }), "bid on cancelled");
    await assertReverts(ownerFactory.cancelAuction(a.address, "again"), "cancel twice");
    for (const w of [bidderA, bidderB, seller, owner]) {
      assert.equal((await attempt(a.read.getDataWithToken(await siweToken(fx.read, w)))).reverted, true, "payload unreadable");
    }

    // the leader can pull the refund (cancelled), as can the other bidder
    // (amounts are a few wei, far below gas costs, so check contract state and escrow instead of wallet balances)
    assert.equal(await a.read.getBid(bidderA.address), 100n);
    await sendTx(a.asWallet(bidderA).withdrawRefund());
    assert.equal(await a.read.getBid(bidderA.address), 0n);
    assert.equal(await plain.getBalance(a.address), 60n);
    await sendTx(a.asWallet(bidderB).withdrawRefund());
    assert.equal(await plain.getBalance(a.address), 0n);

    // processRefunds honours cancelled (leader is refunded in the batch)
    const b = await createAuction(fx, seller, { minimum: 1, duration: 5 });
    await sendTx(b.asWallet(bidderB).contribute({ value: 20 }));
    await sendTx(b.asWallet(bidderA).contribute({ value: 30 }));
    await sendTx(ownerFactory.cancelAuction(b.address, ""));
    await sendTx(b.asWallet(outsider).processRefunds(10));
    assert.equal(await plain.getBalance(b.address), 0n);
    assert.equal(await b.read.getBid(bidderA.address), 0n);
  });

  await t.test("cancel after finalize only hides; no money moves", async () => {
    const a = await createAuction(fx, seller, { minimum: 1, duration: 5 });
    await sendTx(a.asWallet(bidderA).contribute({ value: 70 }));
    await sendTx(ownerFactory.closeNow(a.address));
    await sleep(2500);
    await sendTx(a.asWallet(outsider).finalizeAuctionIfNeeded());
    const budgetA = await fx.read.getBudget(bidderA.address);
    const sellerBudget = await fx.read.getBudget(seller.address);
    const receipt = await sendTx(ownerFactory.cancelAuction(a.address, "late"));
    const events = parseEvents(receipt, fx.read.interface);
    assert.equal(events.find((e) => e.name === "AuctionCancelled").args[3], false);
    assert.equal(await fx.read.hidden(a.address), true);
    assert.equal(await a.read.cancelled(), false);
    assert.equal(await fx.read.getBudget(bidderA.address), budgetA);
    assert.equal(await fx.read.getBudget(seller.address), sellerBudget);
    // the winner can still read what they paid for
    assert.equal(await a.read.getDataWithToken(await siweToken(fx.read, bidderA)), PAYLOAD);
  });

  await t.test("hidden flag is storage only: bids and reads still work", async () => {
    const a = await createAuction(fx, seller, { minimum: 1, duration: 5 });
    await assertReverts(fx.asWallet(outsider).setHidden(a.address, true), "non-admin hide");
    await assertReverts(ownerFactory.setHidden(outsider.address, true), "hide non-campaign");
    const receipt = await sendTx(ownerFactory.setHidden(a.address, true));
    assert.ok(parseEvents(receipt, fx.read.interface).some((e) => e.name === "AuctionHiddenChanged"));
    assert.equal(await fx.read.hidden(a.address), true);
    assert.deepEqual([...(await fx.read.getHiddenFlags([a.address, live.address]))], [true, false]);
    await sendTx(a.asWallet(bidderA).contribute({ value: 5 }));
    await sendTx(ownerFactory.setHidden(a.address, false));
    assert.equal(await fx.read.hidden(a.address), false);
  });

  await t.test("disabled users cannot create auctions or bid", async () => {
    const open = await createAuction(fx, seller, { minimum: 10, duration: 5 });
    await sendTx(ownerFactory.setDisabled(outsider.address, true));
    assert.equal(await fx.read.disabled(outsider.address), true);
    await assertReverts(fx.asWallet(outsider).createCampaign(1, "p", "d", 1), "disabled create");
    await assertReverts(open.asWallet(outsider).contribute({ value: 50 }), "disabled bid");
    await sendTx(ownerFactory.setDisabled(outsider.address, false));
    await sendTx(open.asWallet(outsider).contribute({ value: 50 }));
    await assertReverts(ownerFactory.setDisabled(owner.address, true), "cannot disable owner");
  });

  await t.test("hardening: failing seller and failing refund recipient do not block", async () => {
    const helperBuild = compileHelper();
    const helperDeployer = new ContractFactory(helperBuild.abi, `0x${helperBuild.evm.bytecode.object}`, signerOf(seller));
    const helper = await helperDeployer.deploy();
    await helper.waitForDeployment();
    const helperAddress = await helper.getAddress();
    const helperAs = (w) => new Contract(helperAddress, helperBuild.abi, signerOf(w));

    // Seller is a contract that rejects ETH: finalize must still succeed.
    const created = await sendTx(helperAs(seller).create(fx.address, 1, PAYLOAD, "contract seller", 5));
    const auctionAddress = parseEvents(created, fx.read.interface).find((e) => e.name === "AuctionCreated").args[0];
    const auction = {
      address: auctionAddress,
      asWallet: (w) => new Contract(auctionAddress, compiledCampaign.abi, signerOf(w)),
      read: new Contract(auctionAddress, compiledCampaign.abi, wrappedProvider),
    };
    await sendTx(auction.asWallet(bidderA).contribute({ value: 90 }));
    await sendTx(ownerFactory.closeNow(auction.address));
    await sleep(2500);
    await sendTx(auction.asWallet(outsider).finalizeAuctionIfNeeded());
    assert.equal(await auction.read.closed(), true);
    assert.equal(await auction.read.sellerOwed(), 90n);
    assert.equal(await plain.getBalance(auction.address), 90n);
    await assertReverts(auction.asWallet(outsider).withdrawSellerPayment(), "not the seller");
    await assertReverts(helperAs(seller).pullSeller(auction.address), "seller still rejects");
    await sendTx(helperAs(seller).setAccept(true));
    await sendTx(helperAs(seller).pullSeller(auction.address));
    assert.equal(await auction.read.sellerOwed(), 0n);
    assert.equal(await plain.getBalance(auction.address), 0n);
    assert.equal(await plain.getBalance(helperAddress), 90n);

    // A refund recipient that rejects is skipped; the batch survives and the pull refund remains.
    const b = await createAuction(fx, seller, { minimum: 1, duration: 5 });
    await sendTx(helperAs(bidderB).bid(b.address, { value: 11 }));
    await sendTx(helperAs(seller).setAccept(false));
    await sendTx(b.asWallet(bidderA).contribute({ value: 12 }));
    await sendTx(ownerFactory.closeNow(b.address));
    await sleep(2500);
    await sendTx(b.asWallet(outsider).finalizeAuctionIfNeeded());
    const batch = await sendTx(b.asWallet(outsider).processRefunds(10));
    assert.ok(
      parseEvents(batch, b.read.interface).some((e) => e.name === "RefundFailed"),
      "failed refund is reported, not reverted"
    );
    assert.equal(await b.read.getBid(helperAddress), 11n, "pull refund kept");
    await sendTx(helperAs(seller).setAccept(true));
    await sendTx(helperAs(seller).pullRefund(b.address));
    assert.equal(await b.read.getBid(helperAddress), 0n);
  });

  await t.test("factory exposes no unbounded checkEndedAuctions", async () => {
    assert.equal(compiledFactory.abi.some((i) => i.name === "checkEndedAuctions"), false);
    const [next] = await fx.read.checkEndedAuctionsRange.staticCall(0, 5);
    assert.equal(next, 5n);
    await assertReverts(fx.asWallet(outsider).checkEndedAuctionsRange(0, 0), "batch 0");
  });

  await t.test("lazy global reset, held funds and setUserBudget", async () => {
    const lf = await deployFactory(owner);
    const lOwner = lf.asWallet(owner);
    const A = bidderA;
    const B = bidderB;
    const C = outsider;

    const x = await createAuction(lf, seller, { minimum: 1, duration: 5 });
    await sendTx(x.asWallet(A).contribute({ value: 300 })); // A leads, holds 300
    const y = await createAuction(lf, seller, { minimum: 1, duration: 5 });
    await sendTx(y.asWallet(B).contribute({ value: 100 })); // B leads on another auction
    assert.equal(await lf.read.getBudget(A.address), DEFAULT_BUDGET - 300n);
    assert.equal(await lf.read.heldBy(A.address), 300n);

    await assertReverts(lOwner.resetAllBudgets(0), "reset to 0");
    const reset = await sendTx(lOwner.resetAllBudgets(1000));
    const resetEvent = parseEvents(reset, lf.read.interface).find((e) => e.name === "GlobalBudgetReset");
    assert.deepEqual([resetEvent.args[0], resetEvent.args[1], resetEvent.args[2]], [1n, 1000n, owner.address]);
    // O(1): the reset did not touch users, but reads already reflect it minus held funds.
    assert.equal(await lf.read.usersBudget(A.address), DEFAULT_BUDGET - 300n, "raw value is stale until applied");
    assert.equal(await lf.read.getBudget(A.address), 700n);
    assert.equal(await lf.read.getBudget(B.address), 900n);
    assert.equal(await lf.read.getBudget(C.address), 1000n, "unregistered user reads the new default");

    // Lazy application emits BudgetChanged with campaign == address(0).
    const bump = await sendTx(x.asWallet(A).contribute({ value: 50 }));
    const lazy = parseEvents(bump, lf.read.interface).find(
      (e) => e.name === "BudgetChanged" && e.args[0] === ZeroAddress
    );
    assert.ok(lazy, "lazy BudgetChanged emitted");
    assert.equal(lazy.args[1], A.address);
    assert.equal(lf.read.interface.getEvent("BudgetChanged") != null, true);
    assert.equal(await lf.read.getBudget(A.address), 650n);
    assert.equal(await lf.read.heldBy(A.address), 350n);

    // reset below what a user holds floors available at 0
    await sendTx(lOwner.resetAllBudgets(100));
    assert.equal(await lf.read.getBudget(A.address), 0n);
    assert.equal(await lf.read.getBudget(B.address), 0n);
    assert.equal(await lf.read.getBudget(C.address), 100n);

    // setUserBudget respects held funds: total >= held, available = total - held
    await assertReverts(lOwner.setUserBudget(A.address, 349), "total below held");
    await sendTx(lOwner.setUserBudget(A.address, 350));
    assert.equal(await lf.read.getBudget(A.address), 0n);
    await sendTx(lOwner.setUserBudget(A.address, 500));
    assert.equal(await lf.read.getBudget(A.address), 150n);
    assert.equal(await lf.read.heldBy(A.address), 350n);
    await sendTx(lOwner.setUserBudget(C.address, 0)); // unregistered user, zero allowed
    assert.equal(await lf.read.getBudget(C.address), 0n);
    await assertReverts(lf.asWallet(A).setUserBudget(A.address, 9999), "self-service budget");

    // outbid releases the hold back to available
    await sendTx(lOwner.setUserBudget(B.address, 1000)); // held 100 -> available 900
    assert.equal(await lf.read.getBudget(B.address), 900n);
    await sendTx(x.asWallet(B).contribute({ value: 400 })); // outbids A (350)
    assert.equal(await lf.read.heldBy(A.address), 0n);
    assert.equal(await lf.read.getBudget(A.address), 500n, "A total 500 fully available again");
    assert.equal(await lf.read.heldBy(B.address), 500n);
    assert.equal(await lf.read.getBudget(B.address), 500n);
  });
});
