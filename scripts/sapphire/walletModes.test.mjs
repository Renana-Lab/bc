// Wallet-mode confidentiality checks against sapphire-localnet (docker). Localnet only.
//
//   docker run -it -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet
//   REQUIRE_LOCALNET=1 npm run sapphire:test:wallets
//
// For every mode the RAW provider is a recorder, and the provider used by the "app" is
// wrapForSapphire(raw): the same function the app uses (src/real_ethereum/sapphireProvider.js).
// Evidence of encryption is taken from the recorder (what the wallet was actually asked to sign
// and send) and from the transaction as stored on chain.
//
// metamask uses a SIMULATED raw provider (it signs what it is given with a disposable random key,
// like MetaMask does; real MetaMask is not driven here). "local" uses the real local wallet
// implementation (the browser flow is covered by scripts/sapphire/e2e/localWalletE2E.mjs).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  BrowserProvider, Contract, ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Transaction, Wallet,
  getBytes, hexlify, isHexString, toUtf8Bytes,
} from "ethers";
import { isCalldataEnveloped } from "@oasisprotocol/sapphire-paratime";
import { wrapEthersProvider, wrapEthersSigner } from "@oasisprotocol/sapphire-ethers-v6";
import { buildSiweMessage, splitSignature, utf8ToHex } from "../../src/real_ethereum/siwe.mjs";
import { guardProvider, wrapForSapphire } from "../../src/real_ethereum/wallets/sapphireWrap.mjs";
import { createLocalProvider, createLocalWallet, createMemoryStorage } from "../../src/real_ethereum/wallets/localWallet.mjs";
import { getWalletMode } from "../../src/real_ethereum/wallets/walletMode.mjs";

const require = createRequire(import.meta.url);
const compiledFactory = require("../../src/real_ethereum/build/CampaignFactory.json");
const compiledCampaign = require("../../src/real_ethereum/build/Campaign.json");

const RPC_URL = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error("Refusing to run: this suite uses a public dev mnemonic and must only target a local RPC.");
}
const CHAIN_ID = 23293;
const DOMAIN = "localhost:3000";
const NETWORK = { chainId: CHAIN_ID, chainIdHex: "0x5afd", chainName: "Oasis Sapphire Localnet", rpcUrls: [RPC_URL] };
// Public localnet-only development phrase (the localnet funds these accounts).
const MNEMONIC = "test test test test test test test test test test test junk";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const plain = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
const devWallet = (index) =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(plain);

const reachable = await plain.getBlockNumber().then(() => true, () => false);
const skip = reachable ? false : `sapphire-localnet is not reachable at ${RPC_URL}`;
if (!reachable && process.env.REQUIRE_LOCALNET) throw new Error(skip);

const attempt = async (promise) => {
  try { return { reverted: false, result: await promise }; } catch (error) { return { reverted: true, error }; }
};

// ---- raw provider simulations -----------------------------------------------------------------
// A raw provider signs whatever it is handed and records every request (never the key).
const WRITE_METHODS = new Set(["eth_sendTransaction", "eth_signTransaction", "eth_sendRawTransaction"]);
const recording = (raw) => {
  const log = [];
  const provider = {
    ...raw,
    async request(args) {
      log.push({ method: args.method, params: structuredClone(args.params ?? []) });
      return raw.request(args);
    },
  };
  return { provider, log, writes: () => log.filter((entry) => WRITE_METHODS.has(entry.method)) };
};

// Behaves like a MetaMask provider: signs the given tx as-is and broadcasts it.
const simulatedEmbeddedProvider = (key) => {
  const signer = new Wallet(key, plain);
  return {
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_chainId": return NETWORK.chainIdHex;
        case "eth_accounts":
        case "eth_requestAccounts": return [signer.address];
        case "personal_sign": return signer.signMessage(isHexString(params[0]) ? getBytes(params[0]) : params[0]);
        case "eth_sendTransaction": {
          const tx = params[0];
          const sent = await signer.sendTransaction({ to: tx.to, data: tx.data ?? tx.input, value: tx.value, gasLimit: tx.gas });
          return sent.hash;
        }
        default: return plain.send(method, params);
      }
    },
    address: signer.address,
  };
};

const localModeProvider = async (storage = createMemoryStorage()) => {
  const wallet = createLocalWallet({ storage, scryptN: 2 ** 10 });
  await wallet.create("correct horse battery staple");
  return { wallet, storage, raw: createLocalProvider({ wallet, network: NETWORK }) };
};

const makeSiweToken = async (wrapped, account, factoryRead) => {
  const message = buildSiweMessage({
    domain: DOMAIN, address: account, uri: `http://${DOMAIN}`, chainId: CHAIN_ID, now: new Date(Date.now() - 5000),
  });
  const signature = await wrapped.request({ method: "personal_sign", params: [utf8ToHex(message), account] });
  return factoryRead.login(message, splitSignature(signature));
};

test("wallet modes keep calldata confidential on sapphire-localnet", { skip, timeout: 600_000 }, async (t) => {
  assert.equal(getWalletMode(), "metamask", "default wallet mode must stay metamask");
  assert.equal(getWalletMode("local"), "local");
  assert.throws(() => getWalletMode("sepolia-magic"), /Unknown REACT_APP_WALLET_MODE/);
  for (const removed of ["apillon", "privy"]) assert.throws(() => getWalletMode(removed), /Unknown REACT_APP_WALLET_MODE/);

  const seller = devWallet(0);
  const outsider = devWallet(3);
  const faucet = devWallet(4); // localnet faucet: funds disposable participant wallets

  const deployed = await new ContractFactory(
    compiledFactory.abi, `0x${compiledFactory.evm.bytecode.object}`, wrapEthersSigner(seller)
  ).deploy(DOMAIN);
  await deployed.waitForDeployment();
  const factoryAddress = await deployed.getAddress();
  const wrappedPlain = wrapEthersProvider(plain);
  const readFactory = new Contract(factoryAddress, compiledFactory.abi, wrappedPlain);

  // Plain value transfer on localnet (no calldata, so nothing to encrypt).
  const fund = async (address, value) => (await faucet.sendTransaction({ to: address, value })).wait();

  // One auction per mode; the mode's wallet will be its winner.
  const auctions = {};
  for (const mode of ["metamask", "local"]) {
    const secret = `SECRET-${mode}-${Wallet.createRandom().address}`;
    const created = await (await new Contract(factoryAddress, compiledFactory.abi, wrapEthersSigner(seller))
      .createCampaign(1, secret, `public ${mode}`, 1)).wait();
    const parsed = created.logs.map((log) => { try { return readFactory.interface.parseLog(log); } catch { return null; } })
      .find((entry) => entry?.name === "AuctionCreated");
    auctions[mode] = { secret, address: parsed.args[0] };
  }

  // Participants: raw providers recorded, then wrapped exactly like the app wraps them.
  const participants = {};
  for (const mode of ["metamask"]) {
    const rawSim = simulatedEmbeddedProvider(Wallet.createRandom().privateKey);
    const rec = recording(rawSim);
    participants[mode] = { ...rec, address: rawSim.address, wrapped: wrapForSapphire(rec.provider) };
  }
  const local = await localModeProvider();
  const localRec = recording(local.raw);
  participants.local = { ...localRec, address: local.wallet.address, wrapped: wrapForSapphire(localRec.provider), localWallet: local };

  const asContract = (mode, auction) =>
    new Contract(auction.address, compiledCampaign.abi, new BrowserProvider(participants[mode].wrapped, CHAIN_ID, { staticNetwork: true }));
  const campaignRead = (auction) => new Contract(auction.address, compiledCampaign.abi, wrappedPlain);

  // 3. Gas / funding: a zero-balance participant cannot bid (a bid is also native value).
  await t.test("gas: zero-balance wallets cannot bid; a localnet faucet step funds them", async () => {
    for (const mode of Object.keys(participants)) {
      assert.equal(await plain.getBalance(participants[mode].address), 0n);
      const signer = await new BrowserProvider(participants[mode].wrapped, CHAIN_ID, { staticNetwork: true }).getSigner();
      const denied = await attempt(new Contract(auctions[mode].address, compiledCampaign.abi, signer).contribute({ value: 100 }));
      assert.equal(denied.reverted, true, `${mode} must not be able to bid with a zero balance`);
      await fund(participants[mode].address, 10n ** 18n);
      assert.ok((await plain.getBalance(participants[mode].address)) > 0n);
    }
  });

  await t.test("1. bid calldata is enveloped for every mode (recorder + on-chain)", async () => {
    for (const mode of Object.keys(participants)) {
      const auction = auctions[mode];
      participants[mode].log.length = 0;
      const signer = await new BrowserProvider(participants[mode].wrapped, CHAIN_ID, { staticNetwork: true }).getSigner();
      const bid = await new Contract(auction.address, compiledCampaign.abi, signer).contribute({ value: 100 });
      await bid.wait();

      const writes = participants[mode].writes();
      assert.ok(writes.length >= 1, `${mode}: expected at least one write`);
      for (const write of writes) {
        const data = write.params[0].data ?? write.params[0].input;
        assert.equal(isCalldataEnveloped(data), true, `${mode}: ${write.method} calldata must be enveloped`);
        assert.notEqual(data, new Contract(auction.address, compiledCampaign.abi).interface.encodeFunctionData("contribute"));
      }
      const onChain = await plain.getTransaction(bid.hash);
      assert.equal(isCalldataEnveloped(onChain.data), true, `${mode}: on-chain calldata must be enveloped`);
      assert.equal(
        onChain.data.includes(new Contract(auction.address, compiledCampaign.abi).interface.getFunction("contribute").selector.slice(2)),
        false, `${mode}: plaintext selector must not appear on chain`);
    }
  });

  await t.test("bypass checks: plaintext through the raw provider is refused by the guard; control shows the risk", async () => {
    const mode = "metamask";
    const iface = new Contract(auctions[mode].address, compiledCampaign.abi).interface;
    const plaintext = iface.encodeFunctionData("contribute");
    const rec = recording(simulatedEmbeddedProvider(Wallet.createRandom().privateKey));
    const guarded = guardProvider(rec.provider);
    for (const method of ["eth_sendTransaction", "eth_call", "eth_estimateGas"]) {
      const refused = await attempt(guarded.request({ method, params: [{ to: auctions[mode].address, data: plaintext }] }));
      assert.equal(refused.reverted, true, `${method} with plaintext calldata must be refused`);
      assert.match(refused.error.message, /plaintext calldata/);
    }
    assert.equal((await attempt(guarded.request({ method: "wallet_sendCalls", params: [{}] }))).reverted, true);
    // The paratime wrapper only encrypts `params[0].data`; calldata hidden in `input` must be refused too.
    const viaInput = await attempt(guarded.request({ method: "eth_sendTransaction", params: [{ to: auctions[mode].address, input: plaintext }] }));
    assert.equal(viaInput.reverted, true, "calldata passed as `input` must be refused");
    assert.equal(rec.log.length, 0, "refused requests must never reach the wallet");

    // Local provider refuses even when called directly (e.g. someone bypasses the guard).
    const refusedLocal = await attempt(participants.local.provider.request({
      method: "eth_sendTransaction", params: [{ from: participants.local.address, to: auctions.local.address, data: plaintext }],
    }));
    assert.equal(refusedLocal.reverted, true);
    assert.match(refusedLocal.error.message, /plaintext calldata/);
    // A raw signed transaction with plaintext calldata is refused too.
    const raw = await new Wallet(Wallet.createRandom().privateKey).signTransaction(
      Transaction.from({ to: auctions[mode].address, data: plaintext, chainId: CHAIN_ID, gasLimit: 100000, gasPrice: 1, nonce: 0 }));
    const refusedRaw = await attempt(guarded.request({ method: "eth_sendRawTransaction", params: [raw] }));
    assert.equal(refusedRaw.reverted, true);
    assert.match(refusedRaw.error.message, /plaintext calldata/);
    for (const method of ["eth_sendUserOperation", "eth_createAccessList", "debug_traceCall"]) {
      assert.match((await attempt(guarded.request({ method, params: [{}] }))).error.message, /not supported/);
    }
    // A public-key query must not smuggle plaintext through `input`.
    const smuggle = await attempt(guarded.request({ method: "eth_call", params: [{ to: "0x" + "1".repeat(40), data: "0x", input: plaintext }] }));
    assert.match(smuggle.error.message, /plaintext calldata/);
    assert.equal(rec.log.length, 0, "refused requests must never reach the wallet");

    // Control: the same simulated raw provider, used WITHOUT the guard/wrapper, would put the call on
    // chain in cleartext. (Not executed here to avoid emitting a plaintext tx; the guard tests above
    // show the refusal happens before the wallet is reached.)
    assert.equal(isCalldataEnveloped(plaintext), false);
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  // Each mode wallet is the only (hence winning) bidder of its own auction; wait for the auctions to close.
  const endsAt = Math.max(...await Promise.all(Object.values(auctions).map(async (a) => Number((await campaignRead(a).getSummary())[8]) * 1000)));
  await sleep(Math.max(0, endsAt + 8000 - Date.now()));
  for (const auction of Object.values(auctions)) {
    await (await new Contract(auction.address, compiledCampaign.abi, wrapEthersSigner(outsider)).finalizeAuctionIfNeeded()).wait();
  }

  await t.test("2. winner signs SIWE with personal_sign and reads via getDataWithToken; non-winner cannot", async () => {
    for (const mode of Object.keys(participants)) {
      const auction = auctions[mode];
      const token = await makeSiweToken(participants[mode].wrapped, participants[mode].address, readFactory);
      assert.equal(await campaignRead(auction).getDataWithToken(token), auction.secret, `${mode} winner must read the payload`);

      // Another mode's wallet (a non-winner of THIS auction) is denied.
      const otherMode = mode === "metamask" ? "local" : "metamask";
      const otherToken = await makeSiweToken(participants[otherMode].wrapped, participants[otherMode].address, readFactory);
      assert.equal((await attempt(campaignRead(auction).getDataWithToken(otherToken))).reverted, true, `${otherMode} must be denied on ${mode}'s auction`);
    }
  });

  await t.test("4. recovery (local wallet): reload keeps the key; wrong passphrase fails; forget/other browser loses it", async () => {
    const { wallet, storage } = participants.local.localWallet;
    const address = wallet.address;
    wallet.lock();
    assert.equal(wallet.isUnlocked(), false);
    assert.equal((await attempt(wallet.signMessage("x"))).reverted, true);

    // "Reload": a new wallet object on the same IndexedDB storage can unlock with the passphrase.
    const reloaded = createLocalWallet({ storage, scryptN: 2 ** 10 });
    assert.equal(await reloaded.exists(), true);
    assert.equal((await attempt(reloaded.unlock("not the passphrase"))).reverted, true);
    assert.equal(await reloaded.unlock("correct horse battery staple"), address);

    // Encrypted backup restores the same account in "another browser" (fresh storage).
    const backup = await reloaded.exportEncryptedBackup();
    const decrypted = await Wallet.fromEncryptedJson(backup, "correct horse battery staple");
    assert.equal(backup.toLowerCase().includes(decrypted.privateKey.slice(2).toLowerCase()), false, "backup must not contain the raw key");
    assert.equal(JSON.parse(backup).version, 3, "backup is an encrypted keystore (v3)");
    const otherBrowser = createLocalWallet({ storage: createMemoryStorage(), scryptN: 2 ** 10 });
    assert.equal(await otherBrowser.exists(), false, "a different browser has no wallet");
    assert.equal(await otherBrowser.importEncryptedBackup(backup, "correct horse battery staple"), address);

    // Site data cleared without a backup: a new random wallet, and the old winner payload is unreadable.
    await reloaded.forget();
    const afterClear = createLocalWallet({ storage, scryptN: 2 ** 10 });
    assert.equal(await afterClear.exists(), false);
    const fresh = await afterClear.create("another passphrase 123");
    assert.notEqual(fresh, address);
    const freshProvider = wrapForSapphire(createLocalProvider({ wallet: afterClear, network: NETWORK }));
    const freshToken = await makeSiweToken(freshProvider, fresh, readFactory);
    assert.equal((await attempt(campaignRead(auctions.local).getDataWithToken(freshToken))).reverted, true);
  });

  await t.test("key hygiene: the local provider never returns or logs key material", async () => {
    const { wallet } = await localModeProvider();
    const provider = createLocalProvider({ wallet, network: NETWORK });
    const backup = await wallet.exportEncryptedBackup();
    const key = (await Wallet.fromEncryptedJson(backup, "correct horse battery staple")).privateKey;
    const logged = [];
    const originals = ["log", "info", "warn", "error", "debug"].map((name) => [name, console[name]]);
    originals.forEach(([name]) => { console[name] = (...args) => logged.push(args.map(String).join(" ")); });
    try {
      for (const method of ["eth_accounts", "eth_chainId", "eth_requestAccounts"]) await provider.request({ method });
      await provider.request({ method: "personal_sign", params: [hexlify(toUtf8Bytes("hi")), wallet.address] });
      await attempt(provider.request({ method: "eth_signTypedData_v4", params: [wallet.address, "{}"] }));
      await attempt(provider.request({ method: "eth_sendTransaction", params: [{ to: wallet.address, data: "0xd7bb99ba" }] }));
    } finally {
      originals.forEach(([name, fn]) => { console[name] = fn; });
    }
    assert.equal(logged.join(" ").toLowerCase().includes(key.slice(2).toLowerCase()), false, "key must never be logged");
    // The provider and wallet objects expose no key-bearing members.
    assert.equal(Object.keys(wallet).some((name) => /key|secret|mnemonic/i.test(name)), false);
    assert.equal(JSON.stringify(provider, (_k, v) => (typeof v === "function" ? undefined : v)).includes(key.slice(2)), false);
  });
});
