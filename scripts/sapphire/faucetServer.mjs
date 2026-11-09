// Localnet-only dev server that runs the REAL faucet Lambda handler (infrastructure/faucet/handler.js)
// with an in-memory table and a disposable faucet key, so the app's "Request test funds" button can
// be tried against sapphire-localnet:
//   node scripts/sapphire/faucetServer.mjs            (listens on 127.0.0.1:8787; set REACT_APP_FAUCET_URL=http://127.0.0.1:8787)
// It refuses to start unless the RPC is local, generates its own throwaway faucet key (funded from
// the public localnet dev account) and prints a few participant links. No real keys belong here.
import http from "node:http";
import { createRequire } from "node:module";
import { HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet } from "ethers";

const require = createRequire(import.meta.url);
const { createFaucetHandler, createEthersChain } = require("../../infrastructure/faucet/handler.js");
const { createMemoryStore } = require("../../infrastructure/faucet/memoryStore.js");
const { generatePids, uploadPids } = require("../faucet/pidTools.js");

const RPC = process.env.SAPPHIRE_LOCALNET_RPC || "http://localhost:8545";
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(RPC)) throw new Error("Refusing to run against a non-local RPC.");
const provider = new JsonRpcProvider(RPC, 23293, { staticNetwork: true, batchMaxCount: 1 });
const funder = HDNodeWallet.fromMnemonic(
  Mnemonic.fromPhrase("test test test test test test test test test test test junk"), // public localnet dev phrase
  "m/44'/60'/0'/0/4"
).connect(provider);
const faucetWallet = Wallet.createRandom();
await (await funder.sendTransaction({ to: faucetWallet.address, value: 10n ** 19n })).wait();

const store = createMemoryStore();
const pids = generatePids(Number(process.env.FAUCET_PIDS || 5));
await uploadPids(store, pids);
const handle = createFaucetHandler({
  store,
  chain: createEthersChain(provider),
  getPrivateKey: async () => faucetWallet.privateKey,
  config: {
    chainId: 23293, amountWei: BigInt(process.env.FAUCET_AMOUNT_WEI || 10n ** 18n), rateLimit: 50, globalRateLimit: 500,
    rateWindowSeconds: 600, leaseSeconds: 60, confirmTimeoutMs: 30000,
  },
});

http
  .createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (request.url !== "/claim") return response.writeHead(404).end();
    let body = "";
    for await (const chunk of request) body += chunk;
    const result = await handle({ body, requestContext: { http: { method: request.method, sourceIp: request.socket.remoteAddress } } });
    response.writeHead(result.statusCode, result.headers).end(result.body);
  })
  .listen(8787, "127.0.0.1", () => {
    console.log("localnet faucet (real handler, in-memory table) on http://127.0.0.1:8787/claim");
    for (const pid of pids) console.log(`  http://localhost:3000/?pid=${pid}`);
  });
