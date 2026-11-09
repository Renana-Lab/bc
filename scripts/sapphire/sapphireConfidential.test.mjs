// Confidentiality tests against Oasis sapphire-localnet (docker). Nothing here touches a public chain.
//
//   docker run -it -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet
//   npm run sapphire:test        (or: node --test scripts/sapphire/sapphireConfidential.test.mjs)
//
// Set REQUIRE_LOCALNET=1 to fail (instead of skip) when the localnet is unreachable.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { HDNodeWallet, JsonRpcProvider, ContractFactory, Contract, Mnemonic, hexlify, toUtf8Bytes, id } from "ethers";
import { wrapEthersSigner, wrapEthersProvider } from "@oasisprotocol/sapphire-ethers-v6";
import { buildSiweMessage, splitSignature } from "../../src/real_ethereum/siwe.mjs";

const require = createRequire(import.meta.url);
const compiledFactory = require("../../src/real_ethereum/build/CampaignFactory.json");
const compiledCampaign = require("../../src/real_ethereum/build/Campaign.json");

const RPC_URL = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
const CHAIN_ID = 23293;
const DOMAIN = "localhost:3000";
// The sapphire-localnet container funds accounts derived from this well-known public
// development phrase. It only holds localnet test funds.
const MNEMONIC =
  process.env.SAPPHIRE_LOCALNET_MNEMONIC ||
  "test test test test test test test test test test test junk";
const SECRET = "TOP-SECRET-PAYLOAD-7f3a91c2-do-not-leak";
const SECRET_HEX = hexlify(toUtf8Bytes(SECRET)).slice(2).toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const plain = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = (index) =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(plain);

const reachable = await plain.getBlockNumber().then(() => true, () => false);
const skip = reachable ? false : `sapphire-localnet is not reachable at ${RPC_URL}`;
if (!reachable && process.env.REQUIRE_LOCALNET) throw new Error(skip);

const containsSecret = (value) => {
  const text = String(value).toLowerCase();
  return text.includes(SECRET_HEX) || text.includes(SECRET.toLowerCase());
};
const attempt = async (promise) => {
  try {
    return { reverted: false, result: await promise };
  } catch (error) {
    return { reverted: true, error };
  }
};
// A read that did not revert must at least not contain the payload.
const assertNoLeak = (outcome, label) => {
  if (!outcome.reverted) assert.equal(containsSecret(outcome.result), false, label);
};

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

test("sapphire confidentiality", { skip, timeout: 300_000 }, async (t) => {
  const seller = wallet(0);
  const bidder = wallet(1);
  const loser = wallet(2);
  const outsider = wallet(3);

  const sellerSigner = wrapEthersSigner(seller);
  const deployer = new ContractFactory(
    compiledFactory.abi,
    `0x${compiledFactory.evm.bytecode.object}`,
    sellerSigner
  );
  const deployed = await deployer.deploy(DOMAIN);
  await deployed.waitForDeployment();
  const factoryAddress = await deployed.getAddress();
  // The localnet gateway caps eth_getLogs ranges, so start at the factory deployment block.
  const startBlock = (await deployed.deploymentTransaction().wait()).blockNumber;
  const factoryAs = (runner) => new Contract(factoryAddress, compiledFactory.abi, runner);
  // Encrypted view calls without a signature: public reads and token-authenticated reads.
  const wrappedProvider = wrapEthersProvider(plain);
  const readFactory = factoryAs(wrappedProvider);

  const tx = await factoryAs(sellerSigner).createCampaign(1, SECRET, "public description", 1);
  const receipt = await tx.wait();
  const created = receipt.logs
    .map((log) => {
      try {
        return readFactory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "AuctionCreated");
  const campaignAddress = created.args[0];
  const campaignAs = (runner) => new Contract(campaignAddress, compiledCampaign.abi, runner);
  const readCampaign = campaignAs(wrappedProvider);
  const getDataCall = readCampaign.interface.encodeFunctionData("getData");

  await t.test("creation transaction input does not contain the payload in cleartext", async () => {
    const onChain = await plain.getTransaction(tx.hash);
    assert.ok(onChain.data.length > 10);
    assert.equal(containsSecret(onChain.data), false);
    // Control: the same call without the wrapper would carry the payload in cleartext.
    const unwrapped = deployer.interface.encodeFunctionData("createCampaign", [1, SECRET, "d", 1]);
    assert.equal(containsSecret(unwrapped), true);
  });

  await t.test("payload is unreachable via getSummary, a getter, spoofed eth_call, events and storage", async () => {
    assert.equal(compiledCampaign.abi.some((item) => item.name === "dataForSell"), false);

    const summary = await readCampaign.getSummary();
    assert.equal(summary.length, 9);
    assert.equal(summary[5], "public description");
    assert.equal(containsSecret(JSON.stringify(summary.map(String))), false);

    assertNoLeak(
      await attempt(plain.call({ to: campaignAddress, data: id("dataForSell()").slice(0, 10) })),
      "dataForSell() selector"
    );

    for (const provider of [plain, wrappedProvider]) {
      assertNoLeak(
        await attempt(provider.call({ to: campaignAddress, from: seller.address, data: getDataCall })),
        "getData with spoofed from"
      );
    }

    const logs = await plain.getLogs({ fromBlock: startBlock, toBlock: "latest" });
    assert.ok(logs.length > 0);
    assert.equal(logs.some((log) => containsSecret(log.data) || log.topics.some(containsSecret)), false);

    for (let slot = 0; slot < 24; slot += 1) {
      assert.equal(containsSecret(await plain.getStorage(campaignAddress, slot)), false, `storage slot ${slot}`);
    }
  });

  await (await campaignAs(wrapEthersSigner(loser)).contribute({ value: 50 })).wait();
  await (await campaignAs(wrapEthersSigner(bidder)).contribute({ value: 100 })).wait();

  await t.test("nobody can read the payload before the auction is finalized", async () => {
    const early = await attempt(readCampaign.getDataWithToken(await siweToken(readFactory, bidder)));
    assert.equal(early.reverted, true);
  });

  const endsAt = Number((await readCampaign.getSummary())[8]) * 1000;
  await sleep(Math.max(0, endsAt + 8000 - Date.now()));
  await (await campaignAs(wrapEthersSigner(outsider)).finalizeAuctionIfNeeded()).wait();

  await t.test("only the winning bidder can read the payload after close", async () => {
    assert.equal(await readCampaign.getDataWithToken(await siweToken(readFactory, bidder)), SECRET);

    for (const other of [loser, seller, outsider]) {
      const denied = await attempt(readCampaign.getDataWithToken(await siweToken(readFactory, other)));
      assert.equal(denied.reverted, true, `${other.address} must be denied`);
    }
    assert.equal((await attempt(readCampaign.getDataWithToken("0x"))).reverted, true);
    assert.equal((await attempt(readCampaign.getDataWithToken("0x1234"))).reverted, true);

    // Unauthenticated getData() with the winner spoofed as `from` must not return the payload.
    for (const provider of [plain, wrappedProvider]) {
      assertNoLeak(
        await attempt(provider.call({ to: campaignAddress, from: bidder.address, data: getDataCall })),
        "getData with spoofed winner"
      );
    }
  });

  await t.test("events after close and refunds still do not leak the payload", async () => {
    const logs = await plain.getLogs({ fromBlock: startBlock, toBlock: "latest" });
    assert.equal(logs.some((log) => containsSecret(log.data)), false);
  });
});
