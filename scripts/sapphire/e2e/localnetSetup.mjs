// Localnet helper: fund an address and/or create/finalize an auction. Localnet only.
//   node scripts/sapphire/e2e/localnetSetup.mjs fund 0xADDRESS
//   node scripts/sapphire/e2e/localnetSetup.mjs create <minutes>
//   node scripts/sapphire/e2e/localnetSetup.mjs finalize 0xAUCTION
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Contract, HDNodeWallet, JsonRpcProvider, Mnemonic } from "ethers";
import { wrapEthersSigner } from "@oasisprotocol/sapphire-ethers-v6";
const require = createRequire(import.meta.url);
const factoryAbi = require("../../../src/real_ethereum/build/CampaignFactory.json").abi;
const campaignAbi = require("../../../src/real_ethereum/build/Campaign.json").abi;
const plain = new JsonRpcProvider("http://localhost:8545", 23293, { staticNetwork: true, batchMaxCount: 1 });
const dev = (i) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase("test test test test test test test test test test test junk"), `m/44'/60'/0'/0/${i}`).connect(plain);
const [cmd, arg] = process.argv.slice(2);
if (cmd === "fund") {
  await (await dev(4).sendTransaction({ to: arg, value: 10n ** 18n })).wait();
  console.log("funded", arg, (await plain.getBalance(arg)).toString());
} else if (cmd === "create") {
  const factoryAddress = readFileSync(new URL("../../../.env", import.meta.url), "utf8").match(/^REACT_APP_REAL_FACTORY_ADDRESS=(0x[0-9a-fA-F]{40})/m)[1];
  const factory = new Contract(factoryAddress, factoryAbi, wrapEthersSigner(dev(0)));
  const receipt = await (await factory.createCampaign(1, "CHECK-PAYLOAD-localnet", "check auction", Number(arg || 8))).wait();
  console.log("auction", receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "AuctionCreated").args[0]);
} else if (cmd === "finalize") {
  await (await new Contract(arg, campaignAbi, wrapEthersSigner(dev(3))).finalizeAuctionIfNeeded()).wait();
  console.log("finalized", arg);
}
