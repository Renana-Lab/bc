const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const keys = new Map();
async function deliveryKey(wallet, directory) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || "")) throw new Error("Invalid delivery wallet");
  const id = wallet.toLowerCase();
  const file = path.join(directory, `${id}.json`);
  if (!keys.has(file)) keys.set(file, (async () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let record;
    if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, "utf8"));
    else {
      record = await new Promise((resolve, reject) => crypto.generateKeyPair("rsa", {
        modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey: publicKey.toString("base64"), privateKey })));
      try { fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; record = JSON.parse(fs.readFileSync(file, "utf8")); }
    }
    return { ...record, fingerprint: `0x${crypto.createHash("sha256").update(Buffer.from(record.publicKey, "base64")).digest("hex")}` };
  })());
  return keys.get(file);
}

async function prepareAuction({ wallet, text, factory, chainId, directory }) {
  const base = String(process.env.REACT_APP_PROTECTED_API_URL || process.env.PROTECTED_API_URL || "").replace(/\/$/, "");
  const origin = process.env.PROTECTED_ORIGIN;
  if (!base.startsWith("https://") || !origin?.startsWith("https://")) throw new Error("Protected API URL and allowed PROTECTED_ORIGIN are required");
  const api = async (route, body, token) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(20000), headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Protected API failed (${response.status})`);
    return value;
  };
  const config = await api("/config");
  if (Number(config.chainId) !== Number(chainId) || config.factory.toLowerCase() !== factory.toLowerCase()) throw new Error("Protected factory/network mismatch");
  const key = await deliveryKey(wallet.address, directory);
  const challenge = await api("/challenge", { wallet: wallet.address, publicKey: key.publicKey });
  const { Wallet } = require("ethers");
  const signer = new Wallet(wallet.privateKey);
  const types = { ...challenge.typedData.types };
  delete types.EIP712Domain;
  const signature = signer.signTypedData
    ? await signer.signTypedData(challenge.typedData.domain, types, challenge.typedData.message)
    : await signer._signTypedData(challenge.typedData.domain, types, challenge.typedData.message);
  const session = await api("/session", { challengeId: challenge.challengeId, signature });
  const { sealText, randomNonce } = await import(pathToFileURL(path.join(__dirname, "crypto.mjs")).href);
  const nonce = randomNonce();
  const sealed = await sealText(text, { chainId, factory, seller: wallet.address, nonce }, config.publicKey);
  const body = JSON.stringify(sealed.envelope);
  const upload = await api("/uploads", { nonce, wrappedKey: sealed.wrappedKey, ciphertextHash: sealed.ciphertextHash, envelopeBytes: Buffer.byteLength(body) }, session.token);
  if (!upload.ready) {
    const response = await fetch(upload.uploadUrl, { method: "PUT", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json" }, body });
    if (!response.ok) throw new Error("Encrypted upload failed");
  }
  const completed = await api(`/uploads/${encodeURIComponent(upload.id)}/complete`, {}, session.token);
  if (!completed.ready || completed.ciphertextHash !== sealed.ciphertextHash) throw new Error("Encrypted upload not verified");
  return { nonce, ciphertextHash: sealed.ciphertextHash, sellerKeyHash: key.fingerprint };
}
module.exports = { deliveryKey, prepareAuction };
