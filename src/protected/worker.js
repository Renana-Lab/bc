/* global globalThis */
import { generateDeliveryKey, exportPublicKey, fingerprintPublicKey, sealText, unwrapKey, openEnvelope } from "./crypto.mjs";

globalThis.onmessage = async ({ data: { id, action, args } }) => {
  try {
    let result;
    if (action === "generate") {
      const pair = await generateDeliveryKey();
      const publicKey = await exportPublicKey(pair.publicKey);
      result = { privateKey: pair.privateKey, publicKey, fingerprint: await fingerprintPublicKey(publicKey) };
    } else if (action === "seal") {
      result = await sealText(...args);
    } else if (action === "open") {
      const [envelope, wrappedKey, privateKey, context, hash] = args;
      const raw = await unwrapKey(wrappedKey, privateKey);
      try { result = await openEnvelope(envelope, raw, context, hash); }
      finally { raw.fill(0); }
    } else throw new Error("Unknown encryption operation");
    globalThis.postMessage({ id, result });
  } catch (_) {
    globalThis.postMessage({ id, error: "Encryption operation failed. Verify the payload and retry." });
  }
};
