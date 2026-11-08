const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const esbuild = require("esbuild");
const path = require("node:path");

const wallet = "0x" + "1".repeat(40);
const factory = "0x" + "2".repeat(40);
const hash = "0x" + "3".repeat(64);

async function harness() {
  const compiled = await esbuild.build({
    entryPoints: [path.join(__dirname, "client.js")], bundle: true, write: false, format: "cjs", logLevel: "silent",
    define: { "import.meta.url": '"https://protected.invalid/client.js"', "process.env.REACT_APP_PROTECTED_MARKET": '"true"', "process.env.REACT_APP_PROTECTED_API_URL": '"https://protected.invalid"' },
    plugins: [{ name: "wallet-fixtures", setup(build) {
      build.onResolve({ filter: /keys$|ethereumProvider$|walletAccess$|marketConfig$/ }, args => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path.endsWith("keys") ? "let key; export const getDeliveryKey = async (wallet,chain,generate) => key || (key = await generate());" :
        args.path.endsWith("ethereumProvider") ? "export const getEthereumProvider=()=>globalThis.provider;" :
        args.path.endsWith("marketConfig") ? "export const getActiveFactoryAddress=()=>globalThis.factory;" :
        "export const getWalletAccess=()=>globalThis.access; export const requireWalletAccess=async()=>globalThis.access; export const subscribeWalletAccess=fn=>{globalThis.revoke=fn; return ()=>{};};"
      }));
    } }],
  });
  const calls = [];
  let signatures = 0;
  let uploadIndex = 0;
  const context = {
    exports: {}, crypto: webcrypto, TextEncoder, URL, setTimeout, clearTimeout, AbortController,
    access: { status: "connected", account: wallet }, factory,
    provider: { request: async ({ method }) => { if (method === "eth_chainId") return "0xaa36a7"; signatures += 1; return "signature"; } },
    Worker: class {
      postMessage({ id, action, args }) {
        const result = action === "generate" ? { publicKey: "spki", privateKey: "private", fingerprint: hash } :
          action === "seal" ? { envelope: { version: 1, context: args[1], iv: "iv", ciphertext: "encrypted" }, wrappedKey: "wrapped", ciphertextHash: hash } : "private data";
        queueMicrotask(() => this.onmessage({ data: { id, result } }));
      }
      terminate() {}
    },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, body, options });
      const result = url.endsWith("/config") ? { chainId: 11155111, factory, publicKey: "kms-public" } :
        url.endsWith("/challenge") ? { challengeId: "challenge", typedData: {} } :
        url.endsWith("/session") ? { token: "session-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 } :
        url.endsWith("/uploads") ? { id: `payload-${++uploadIndex}`, uploadUrl: "https://storage.invalid/object" } :
        url.endsWith("/complete") ? { ready: true, ciphertextHash: hash } : {};
      return { ok: true, status: 200, json: async () => result };
    },
  };
  context.module = { exports: context.exports };
  vm.runInNewContext(compiled.outputFiles[0].text, context);
  return { client: context.module.exports, calls, context, signatures: () => signatures };
}

test("session seconds are normalized and reused across independent creations", async () => {
  const h = await harness();
  await h.client.prepareProtectedAuction({ wallet, text: "identical", operationId: "row-1" });
  await h.client.prepareProtectedAuction({ wallet, text: "identical", operationId: "row-2" });
  assert.equal(h.signatures(), 1);
  const uploads = h.calls.filter(call => call.url.endsWith("/uploads"));
  assert.equal(uploads.length, 2);
  assert.notEqual(uploads[0].body.nonce, uploads[1].body.nonce);
  assert.equal(h.calls.some(call => JSON.stringify(call.body).includes("identical")), false);
  assert.equal(h.calls.find(call => call.url.endsWith("/challenge")).body.wallet, wallet);
});

test("same operation retry reuses verified preparation without uploading again", async () => {
  const h = await harness();
  const first = await h.client.prepareProtectedAuction({ wallet, text: "payload", operationId: "retry" });
  const second = await h.client.prepareProtectedAuction({ wallet, text: "payload", operationId: "retry" });
  assert.equal(first.nonce, second.nonce);
  assert.equal(h.calls.filter(call => call.url.endsWith("/uploads")).length, 1);
});

test("bidding key generation performs no API, signature, or KMS work", async () => {
  const h = await harness();
  assert.equal(await h.client.getBidKeyFingerprint(wallet, 11155111), hash);
  assert.equal(h.calls.length, 0);
  assert.equal(h.signatures(), 0);
  await assert.rejects(h.client.getBidKeyFingerprint(wallet, 1), /Sepolia/);
});

test("failed completion retries the same encrypted upload without storing plaintext or signing again", async () => {
  const h = await harness();
  const fetch = h.context.fetch;
  let failOnce = true;
  h.context.fetch = async (url, options) => {
    if (url.endsWith('/complete') && failOnce) { failOnce = false; return { ok: false, status: 503, json: async () => ({ error: 'temporarily unavailable' }) }; }
    return fetch(url, options);
  };
  const input = { wallet, text: 'marker-private', operationId: 'retry-completion' };
  await assert.rejects(h.client.prepareProtectedAuction(input), /temporarily unavailable/);
  await h.client.prepareProtectedAuction(input);
  assert.equal(h.calls.filter(call => call.url.endsWith('/uploads')).length, 1);
  assert.equal(h.calls.filter(call => call.url === 'https://storage.invalid/object').length, 1);
  assert.equal(h.signatures(), 1);
  assert.equal(h.calls.some(call => JSON.stringify(call.body).includes('marker-private')), false);
});

test("creation retries and simultaneous submissions reuse the receipt, without legacy plaintext calls", async () => {
  const h = await harness();
  const sent = [];
  const contract = { methods: { createEncryptedCampaign: (...args) => ({ send: async options => { sent.push({ args, options }); return { status: true }; } }) } };
  const input = { factory: contract, wallet, minimum: "50", text: "payload", description: "public description", duration: "10", operationId: "single" };
  await Promise.all([h.client.createProtectedAuction(input), h.client.createProtectedAuction(input)]);
  await h.client.createProtectedAuction(input);
  assert.equal(sent.length, 1);
  await h.client.createProtectedAuction({ ...input, operationId: "new-intent" });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].args.includes("payload"), false);
});

test("chain change events revoke prepared state even when the wallet account is unchanged", async () => {
  const h = await harness();
  const handlers = new Map();
  h.context.provider.on = (event, fn) => handlers.set(event, fn);
  await h.client.prepareProtectedAuction({ wallet, text: "payload", operationId: "network" });
  let revoked = false;
  h.client.subscribeProtectedRevocation(() => { revoked = true; });
  handlers.get("chainChanged")("0x1");
  assert.equal(revoked, true);
  await h.client.prepareProtectedAuction({ wallet, text: "payload", operationId: "network" });
  assert.equal(h.signatures(), 2);
});

test("uncertain transaction retries cannot create a second auction after the payload is mined", async () => {
  const h = await harness();
  let used = false;
  let sends = 0;
  const input = { wallet, text: "payload", operationId: "uncertain", factory: { methods: {
    usedPayloadIds: () => ({ call: async () => used }),
    createEncryptedCampaign: () => ({ send: async () => { sends++; used = true; throw new Error("receipt connection lost"); } }),
  } } };
  await assert.rejects(h.client.createProtectedAuction(input), /connection lost/);
  await assert.rejects(h.client.createProtectedAuction(input), /already created/);
  assert.equal(sends, 1);
});

test("MetaMask checking during signature does not revoke an unchanged wallet", async () => {
  const h = await harness();
  const request = h.context.provider.request;
  h.context.provider.request = async options => {
    if (options.method === "eth_signTypedData_v4") {
      h.context.access = { status: "checking", account: "" };
      h.context.revoke();
      h.context.access = { status: "connected", account: wallet };
      h.context.revoke();
    }
    return request(options);
  };
  await h.client.prepareProtectedAuction({ wallet, text: "payload", operationId: "focus" });
  assert.equal(h.signatures(), 1);
});

test("disconnect during signature rejects late successful signature before upload", async () => {
  const h = await harness();
  const request = h.context.provider.request;
  h.context.provider.request = async options => {
    if (options.method === "eth_signTypedData_v4") {
      h.context.access = { status: "locked", account: "" };
      h.context.revoke();
    }
    return request(options);
  };
  await assert.rejects(h.client.prepareProtectedAuction({ wallet, text: "payload" }));
  assert.equal(h.calls.filter(call => call.url.endsWith("/uploads")).length, 0);
});

test("unverified upload blocks the transaction rather than using plaintext fallback", async () => {
  const h = await harness();
  const fetch = h.context.fetch;
  h.context.fetch = async (url, options) => url.endsWith("/complete")
    ? { ok: true, json: async () => ({ ready: false, ciphertextHash: hash }) }
    : fetch(url, options);
  let sent = false;
  await assert.rejects(h.client.createProtectedAuction({
    wallet, text: "payload", factory: { methods: { createEncryptedCampaign: () => { sent = true; } } },
  }), /not verified/);
  assert.equal(sent, false);
});
