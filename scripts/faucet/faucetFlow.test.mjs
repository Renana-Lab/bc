// End-to-end flow on sapphire-localnet with 5 PARALLEL participants:
// participant code (pid) -> local wallet -> faucet Lambda handler (real signing + real localnet payment)
// -> bid with encrypted calldata -> auction ends -> winner reads the payload via SIWE, others cannot.
// Also tries to claim twice for the same pid (in parallel and afterwards). Localnet only.
//   docker run -it -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet
//   REQUIRE_LOCALNET=1 npm run faucet:test:flow
//
// Stand-ins: the DynamoDB table is the in-memory store (same conditional semantics, see memoryStore.js)
// and the Secrets Manager read is a function returning a disposable random key funded on localnet.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { BrowserProvider, Contract, ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Transaction, Wallet } from "ethers";
import { isCalldataEnveloped } from "@oasisprotocol/sapphire-paratime";
import { wrapEthersProvider, wrapEthersSigner } from "@oasisprotocol/sapphire-ethers-v6";
import { buildSiweMessage, splitSignature, utf8ToHex } from "../../src/real_ethereum/siwe.mjs";
import { wrapForSapphire } from "../../src/real_ethereum/wallets/sapphireWrap.mjs";
import { createLocalProvider, createLocalWallet, createMemoryStorage } from "../../src/real_ethereum/wallets/localWallet.mjs";

const require = createRequire(import.meta.url);
const compiledFactory = require("../../src/real_ethereum/build/CampaignFactory.json");
const compiledCampaign = require("../../src/real_ethereum/build/Campaign.json");
const { createFaucetHandler, createEthersChain } = require("../../infrastructure/faucet/handler.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { generatePids, uploadPids } = require("./pidTools.js");

const RPC_URL = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(RPC_URL)) throw new Error("Refusing to run: local RPC only.");
const CHAIN_ID = 23293;
const DOMAIN = "localhost:3000";
const NETWORK = { chainId: CHAIN_ID, chainIdHex: "0x5afd", chainName: "Oasis Sapphire Localnet", rpcUrls: [RPC_URL] };
const MNEMONIC = "test test test test test test test test test test test junk"; // public, localnet only
const PARTICIPANTS = 5;
const FAUCET_AMOUNT = 5n * 10n ** 17n;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const plain = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
const dev = (i) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(plain);
const reachable = await plain.getBlockNumber().then(() => true, () => false);
const skip = reachable ? false : `sapphire-localnet is not reachable at ${RPC_URL}`;
if (!reachable && process.env.REQUIRE_LOCALNET) throw new Error(skip);
const attempt = async (promise) => { try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error }; } };

test("5 parallel participants: pid, wallet, faucet, bid, winner reads", { skip, timeout: 600_000 }, async (t) => {
  // --- faucet "stack": disposable key (stands in for Secrets Manager), funded on localnet ---
  const faucetWallet = Wallet.createRandom();
  await (await dev(4).sendTransaction({ to: faucetWallet.address, value: 20n * 10n ** 18n })).wait();
  const store = createMemoryStore();
  await store.setState(true, 1); // the faucet is closed by default
  const logs = [];
  let secretReads = 0;
  const handler = createFaucetHandler({
    store, chain: createEthersChain(plain), log: (line) => logs.push(line),
    getPrivateKey: async () => { secretReads += 1; return faucetWallet.privateKey; },
    config: { chainId: CHAIN_ID, amountWei: FAUCET_AMOUNT, rateLimit: 100, globalRateLimit: 1000, rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 30000 },
  });
  const claim = (pid, address, ip) => handler({ body: JSON.stringify({ pid, address }), requestContext: { http: { method: "POST", sourceIp: ip } } });

  // --- auction on localnet (seller = dev account 0) ---
  const seller = dev(0);
  const factory = await new ContractFactory(compiledFactory.abi, `0x${compiledFactory.evm.bytecode.object}`, wrapEthersSigner(seller)).deploy(DOMAIN);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const wrappedPlain = wrapEthersProvider(plain);
  const readFactory = new Contract(factoryAddress, compiledFactory.abi, wrappedPlain);
  const SECRET = `FLOW-PAYLOAD-${Wallet.createRandom().address}`;
  const created = await (await new Contract(factoryAddress, compiledFactory.abi, wrapEthersSigner(seller)).createCampaign(1, SECRET, "flow auction", 1)).wait();
  const auction = created.logs.map((l) => { try { return readFactory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "AuctionCreated").args[0];
  const readCampaign = new Contract(auction, compiledCampaign.abi, wrappedPlain);

  // --- participants: pid + local wallet (all created in parallel) ---
  const pids = generatePids(PARTICIPANTS);
  assert.equal(await uploadPids(store, pids), PARTICIPANTS);
  const people = await Promise.all(pids.map(async (pid, index) => {
    const wallet = createLocalWallet({ storage: createMemoryStorage(), scryptN: 2 ** 10 });
    await wallet.create("participant passphrase 123");
    const raw = createLocalProvider({ wallet, network: NETWORK });
    const requests = [];
    const recorder = { ...raw, request: async (args) => { requests.push(structuredClone(args)); return raw.request(args); } };
    return { pid, index, wallet, address: wallet.address, requests, wrapped: wrapForSapphire(recorder), ip: `198.51.100.${index + 10}` };
  }));
  for (const person of people) assert.equal(await plain.getBalance(person.address), 0n, "participants start with zero balance");

  await t.test("faucet: all 5 claim at once; extra parallel and later claims for the same pid are refused", async () => {
    const faucetBefore = await plain.getBalance(faucetWallet.address);
    const duplicates = [];
    const firstRound = people.map((person) => claim(person.pid, person.address, person.ip));
    // While the first round is in flight, hammer participant 0's pid with the same address from other callers.
    for (let i = 0; i < 4; i += 1) duplicates.push(claim(people[0].pid, people[0].address, `203.0.113.${i + 1}`));
    const first = await Promise.all(firstRound);
    const dups = await Promise.all(duplicates);
    const bodies = first.map((r) => JSON.parse(r.body));
    const paidCount = bodies.filter((b) => b.status === "paid").length;
    assert.equal(paidCount, PARTICIPANTS, `all 5 paid exactly once (got ${JSON.stringify(first.map((r) => r.statusCode))})`);
    for (const r of dups) assert.ok([200, 403, 409].includes(r.statusCode), `duplicate got ${r.statusCode}`);
    assert.equal(dups.filter((r) => r.statusCode === 200 && JSON.parse(r.body).status === "paid").length, 0, "no duplicate was paid");

    // A different address for an already used pid is refused (after the first round, so it cannot win the race).
    assert.equal((await claim(people[0].pid, Wallet.createRandom().address, "203.0.113.9")).statusCode, 403);
    // Later attempts: same pid same address is idempotent, different address is refused.
    const later = await claim(people[1].pid, people[1].address, people[1].ip);
    assert.equal(JSON.parse(later.body).status, "already_paid");
    assert.equal((await claim(people[1].pid, Wallet.createRandom().address, people[1].ip)).statusCode, 403);
    assert.equal((await claim(people[2].pid, Wallet.createRandom().address, "203.0.113.50")).statusCode, 403);

    for (const person of people) assert.equal(await plain.getBalance(person.address), FAUCET_AMOUNT, "each participant got exactly one payment");
    const spent = faucetBefore - (await plain.getBalance(faucetWallet.address));
    assert.ok(spent >= FAUCET_AMOUNT * 5n && spent < FAUCET_AMOUNT * 5n + 10n ** 17n, "faucet paid 5 x amount (plus gas) and nothing more");
    assert.equal(secretReads, 1, "the key was read once and cached");
    const everything = logs.join("\n").toLowerCase();
    for (const secret of [faucetWallet.privateKey.slice(2), ...pids, ...people.map((p) => p.address)]) {
      assert.equal(everything.includes(secret.toLowerCase()), false, "logs must not contain keys, codes or addresses");
    }
  });

  // --- bids: all 5 at once, different amounts (some may legitimately lose the race for "highest") ---
  const amounts = [100, 200, 300, 400, 500];
  let accepted = [];
  await t.test("bids: 5 parallel bids go out with encrypted calldata", async () => {
    const results = await Promise.all(people.map(async (person, index) => {
      const signer = await new BrowserProvider(person.wrapped, CHAIN_ID, { staticNetwork: true }).getSigner();
      const campaign = new Contract(auction, compiledCampaign.abi, signer);
      const outcome = await attempt((async () => { const tx = await campaign.contribute({ value: amounts[index] }); await tx.wait(); return tx.hash; })());
      return { person, outcome };
    }));
    accepted = results.filter((r) => r.outcome.ok);
    assert.ok(accepted.length >= 1, "at least one bid is accepted");
    for (const { person, outcome } of accepted) {
      const onChain = await plain.getTransaction(outcome.value);
      assert.equal(isCalldataEnveloped(onChain.data), true, "bid calldata is an envelope");
      const writes = person.requests.filter((r) => r.method === "eth_sendTransaction");
      assert.ok(writes.length >= 1);
      for (const write of writes) assert.equal(isCalldataEnveloped(write.params[0].data), true);
    }
  });

  await sleep(Math.max(0, Number((await readCampaign.getSummary())[8]) * 1000 + 8000 - Date.now()));
  await (await new Contract(auction, compiledCampaign.abi, wrapEthersSigner(dev(3))).finalizeAuctionIfNeeded()).wait();

  await t.test("winner reads the payload (SIWE signed by the local wallet); the other 4 cannot", async () => {
    const summary = await readCampaign.getSummary();
    const winnerAddress = String(summary[6]).toLowerCase();
    const winner = people.find((person) => person.address.toLowerCase() === winnerAddress);
    assert.ok(winner, "the winner is one of the participants");
    assert.equal(winner.index, Math.max(...accepted.map((r) => r.person.index)), "the highest accepted bid won");

    const tokenFor = async (person) => {
      const message = buildSiweMessage({ domain: DOMAIN, address: person.address, uri: `http://${DOMAIN}`, chainId: CHAIN_ID, now: new Date(Date.now() - 5000) });
      const signature = await person.wrapped.request({ method: "personal_sign", params: [utf8ToHex(message), person.address] });
      return readFactory.login(message, splitSignature(signature));
    };
    assert.equal(await readCampaign.getDataWithToken(await tokenFor(winner)), SECRET);
    for (const person of people.filter((p) => p !== winner)) {
      assert.equal((await attempt(readCampaign.getDataWithToken(await tokenFor(person)))).ok, false, `participant ${person.index} must be denied`);
    }
  });
});
