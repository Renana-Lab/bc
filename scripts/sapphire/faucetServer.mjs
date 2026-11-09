// Localnet-only stub server for the protected faucet design (see docs/EMBEDDED_WALLETS_SPIKE.md).
//   node scripts/sapphire/faucetServer.mjs      (listens on 127.0.0.1:8787)
// It refuses to start unless the RPC is local. The localnet dev phrase is public and only holds
// localnet test funds; override with LOCALNET_FAUCET_MNEMONIC. No real keys belong here.
import http from "node:http";
import { HDNodeWallet, JsonRpcProvider, Mnemonic } from "ethers";
import { createFaucet } from "../../src/real_ethereum/wallets/faucetStub.mjs";

const RPC = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(RPC)) throw new Error("Refusing to run against a non-local RPC.");
const provider = new JsonRpcProvider(RPC, 23293, { staticNetwork: true, batchMaxCount: 1 });
const wallet = HDNodeWallet.fromMnemonic(
  Mnemonic.fromPhrase(process.env.LOCALNET_FAUCET_MNEMONIC || "test test test test test test test test test test test junk"),
  "m/44'/60'/0'/0/4"
).connect(provider);
const faucet = createFaucet({
  amountWei: BigInt(process.env.FAUCET_AMOUNT_WEI || 10n ** 18n),
  send: async (to, value) => (await wallet.sendTransaction({ to, value })).hash,
});

http
  .createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (request.method !== "POST" || request.url !== "/claim") return response.writeHead(404).end();
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 2000) return response.writeHead(413).end();
    }
    try {
      const { pid, address } = JSON.parse(body);
      const { hash } = await faucet.claim(pid, address);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hash }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
  })
  .listen(8787, "127.0.0.1", () => console.log("faucet stub on http://127.0.0.1:8787/claim (localnet)"));
