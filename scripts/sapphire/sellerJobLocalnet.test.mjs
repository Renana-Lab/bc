// Seller job against sapphire-localnet (docker): an auction created through the job core must carry enveloped calldata,
// the payload must not appear on chain, and only the winning bidder can read it after finalization. Skipped without docker
// unless REQUIRE_LOCALNET=1.
//
//   docker run -it -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet
//   node --test scripts/sapphire/sellerJobLocalnet.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { HDNodeWallet, JsonRpcProvider, ContractFactory, Contract, Mnemonic, Transaction, Wallet, hexlify, toUtf8Bytes, parseEther } from "ethers";
import { wrapEthersSigner, wrapEthersProvider } from "@oasisprotocol/sapphire-ethers-v6";
import { isCalldataEnveloped } from "@oasisprotocol/sapphire-paratime";
import { buildSiweMessage, splitSignature } from "../../src/real_ethereum/siwe.mjs";

const require = createRequire(import.meta.url);
const compiledFactory = require("../../src/real_ethereum/build/CampaignFactory.json");
const compiledCampaign = require("../../src/real_ethereum/build/Campaign.json");
const { runSellerJob } = require("../../infrastructure/faucet/sellerJob.js");
const { createSellerChain } = require("../../infrastructure/faucet/sellerChain.js");
const { createMemorySellerStore } = require("../../infrastructure/faucet/sellerStore.js");

const RPC_URL = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
const CHAIN_ID = 23293;
const DOMAIN = "localhost:3000";
const MNEMONIC = process.env.SAPPHIRE_LOCALNET_MNEMONIC || "test test test test test test test test test test test junk"; // public dev phrase, localnet funds only
const SECRET = "SELLER-BOT-PAYLOAD-91c0d7aa-do-not-leak";
const SECRET_HEX = hexlify(toUtf8Bytes(SECRET)).slice(2).toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const plain = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = (index) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(plain);
const reachable = await plain.getBlockNumber().then(() => true, () => false);
const skip = reachable ? false : `sapphire-localnet is not reachable at ${RPC_URL}`;
if (!reachable && process.env.REQUIRE_LOCALNET) throw new Error(skip);

test("seller job on localnet: enveloped calldata, payload readable only by the winner", { skip, timeout: 300_000 }, async (t) => {
  const admin = wallet(0);
  const bidder = wallet(1);
  const loser = wallet(2);
  const outsider = wallet(3);
  const botKey = Wallet.createRandom().privateKey; // disposable, localnet only
  const botAddress = new Wallet(botKey).address;

  const deployer = new ContractFactory(compiledFactory.abi, `0x${compiledFactory.evm.bytecode.object}`, wrapEthersSigner(admin));
  const deployed = await deployer.deploy(DOMAIN, admin.address);
  await deployed.waitForDeployment();
  const factoryAddress = await deployed.getAddress();
  await (await admin.sendTransaction({ to: botAddress, value: parseEther("5") })).wait();

  const chain = createSellerChain({ provider: plain, factoryAddress, chainId: CHAIN_ID });
  const store = createMemorySellerStore();
  store.state.config = {
    enabled: true, presenceMode: "always", minActiveParticipants: 1, activeWindowMinutes: 5, idleGraceMinutes: 5, allowBuyerBotsOnSellerAuctions: false, nextSlot: 2,
    bots: [{ id: "bot-1", running: true, maxConcurrentOpen: 1, spacingSeconds: 60, minNativeBalance: 0.1, items: [{ slot: 1, description: "localnet seller bot item", payload: SECRET, minimumBid: 1, durationMinutes: 1, quantity: 1, seqBase: 0 }] }],
  };
  store.state.version = 1;
  const logs = [];
  const run = () => runSellerJob({ store, chain, log: (line) => logs.push(line), getSecret: async () => ({ bots: [{ id: "bot-1", privateKey: botKey }] }), settings: { sleep, receiptWaitMs: 60_000 } });

  const first = await run();
  assert.equal(first.created, 1, logs.join("\n"));
  const record = [...store.state.records.values()][0];
  assert.equal(record.status, "created");

  await t.test("the creation transaction carries enveloped calldata and no cleartext payload", async () => {
    const onChain = await plain.getTransaction(record.txHash);
    assert.equal(isCalldataEnveloped(onChain.data), true);
    assert.equal(onChain.data.toLowerCase().includes(SECRET_HEX), false);
  });

  await t.test("the real adapter signs createCampaign with enveloped calldata (the core refuses anything else)", async () => {
    const unwrapped = await chain.signCreate({ key: botKey, minimum: 1, dataSell: "x", dataDesc: "y", duration: 1, nonce: await plain.getTransactionCount(botAddress), gasPrice: 10n ** 11n, gasLimit: 3_000_000n });
    assert.equal(unwrapped.enveloped, true);
    assert.equal(isCalldataEnveloped(Transaction.from(unwrapped.rawTx).data), true);
  });

  const readFactory = new Contract(factoryAddress, compiledFactory.abi, wrapEthersProvider(plain));
  const campaignAddress = record.auction;
  const readCampaign = new Contract(campaignAddress, compiledCampaign.abi, wrapEthersProvider(plain));
  const token = async (signer) => {
    const message = buildSiweMessage({ domain: DOMAIN, address: signer.address, uri: `http://${DOMAIN}`, chainId: CHAIN_ID, now: new Date(Date.now() - 5000) });
    return readFactory.login(message, splitSignature(await signer.signMessage(message)));
  };
  const as = (signer) => new Contract(campaignAddress, compiledCampaign.abi, wrapEthersSigner(signer));
  await (await as(loser).contribute({ value: 50 })).wait();
  await (await as(bidder).contribute({ value: 100 })).wait();

  const endsAt = Number(record.endTime) * 1000;
  await sleep(Math.max(0, endsAt + 8000 - Date.now()));
  // The seller bot finalizes its own ended auction on its next run (nobody online: presence is not needed for that).
  store.state.config.presenceMode = "sweep";
  const second = await run();
  assert.equal(second.finalized, 1, logs.join("\n"));
  assert.equal(await readCampaign.closed(), true);

  await t.test("only the winning bidder can read the payload", async () => {
    assert.equal(await readCampaign.getDataWithToken(await token(bidder)), SECRET);
    for (const other of [loser, admin, outsider]) {
      let reverted = false;
      try { await readCampaign.getDataWithToken(await token(other)); } catch { reverted = true; }
      assert.equal(reverted, true);
    }
  });

  await t.test("job logs never contain the payload or the key", () => {
    const text = logs.join("\n");
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(botKey.slice(2)), false);
  });
});
