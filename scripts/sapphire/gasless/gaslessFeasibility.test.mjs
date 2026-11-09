// Feasibility check of Oasis' on-chain-signer gasless pattern (EIP155Signer) on sapphire-localnet.
// Localnet only. Test-only contracts; the marketplace contracts are not touched.
//   REQUIRE_LOCALNET=1 npm run sapphire:test:gasless
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Contract, ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Transaction, Wallet } from "ethers";
import { isCalldataEnveloped } from "@oasisprotocol/sapphire-paratime";
import { wrapEthersProvider, wrapEthersSigner } from "@oasisprotocol/sapphire-ethers-v6";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
const CHAIN_ID = 23293;
const MNEMONIC = "test test test test test test test test test test test junk"; // public, localnet only
const plain = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
const dev = (i) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(plain);

const reachable = await plain.getBlockNumber().then(() => true, () => false);
const skip = reachable ? false : `sapphire-localnet is not reachable at ${RPC_URL}`;
if (!reachable && process.env.REQUIRE_LOCALNET) throw new Error(skip);

const compile = () => {
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "GaslessFeasibility.sol": { content: readFileSync(path.join(here, "GaslessFeasibility.sol"), "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }), {
    import: (file) => {
      try { return { contents: readFileSync(require.resolve(file)).toString() }; } catch { return { error: `not found: ${file}` }; }
    },
  }));
  const errors = (output.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  return output.contracts["GaslessFeasibility.sol"];
};
const attempt = async (promise) => { try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error }; } };

test("gasless EIP155Signer proxy: what it gives and what it breaks", { skip, timeout: 300_000 }, async (t) => {
  const built = compile();
  const owner = dev(0);
  const faucet = dev(4);
  const deploy = async (name, args) => {
    const factory = new ContractFactory(built[name].abi, `0x${built[name].evm.bytecode.object}`, wrapEthersSigner(owner));
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const market = await deploy("MarketStub", []);
  const proxy = await deploy("GaslessProxy", [await market.getAddress()]);
  await (await proxy.initKeypair()).wait();
  const relayer = await proxy.relayer();
  await (await faucet.sendTransaction({ to: relayer, value: 5n * 10n ** 18n })).wait();

  const reader = new Contract(await proxy.getAddress(), built.GaslessProxy.abi, wrapEthersProvider(plain));
  const marketIface = new Contract(await market.getAddress(), built.MarketStub.abi).interface;
  const user = Wallet.createRandom(); // disposable participant with a ZERO balance
  assert.equal(await plain.getBalance(user.address), 0n);

  await t.test("a zero-balance participant gets a bid executed; the relayer pays gas AND the bid value", async () => {
    const relayerBefore = await plain.getBalance(relayer);
    const signed = await reader.makeProxyTx(marketIface.encodeFunctionData("contribute"), 100n);
    // The signed tx hides the inner call: its calldata is a Sapphire envelope.
    assert.equal(isCalldataEnveloped(Transaction.from(signed).data), true);
    const sent = await plain.broadcastTransaction(signed);
    assert.equal((await sent.wait()).status, 1);
    assert.equal(await plain.getBalance(user.address), 0n, "participant never held a coin");
    assert.equal(await market.total(), 100n);
    assert.ok(relayerBefore - (await plain.getBalance(relayer)) > 100n, "relayer paid gas plus the 100 wei bid");
  });

  await t.test("identity is lost: the target sees the proxy contract, not the participant", async () => {
    const seen = await market.lastSender();
    assert.equal(seen, await proxy.getAddress());
    assert.notEqual(seen.toLowerCase(), user.address.toLowerCase());
    // For Campaign this means highestBidder == proxy for everyone, and getDataWithToken would
    // authenticate the proxy, not the winning participant.
  });

  await t.test("a signed tx cannot be replayed, but anyone can ask for one (needs access control)", async () => {
    const innercall = marketIface.encodeFunctionData("contribute");
    const signed = await reader.makeProxyTx(innercall, 1n);
    assert.equal((await (await plain.broadcastTransaction(signed)).wait()).status, 1);
    assert.equal((await attempt(plain.broadcastTransaction(signed))).ok, false, "replay must fail");
    const stranger = new Contract(await proxy.getAddress(), built.GaslessProxy.abi, wrapEthersProvider(plain));
    assert.ok((await stranger.makeProxyTx(innercall, 1n)).length > 10, "no per-user authorization in the base pattern");
  });
});
