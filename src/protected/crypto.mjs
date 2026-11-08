/* global globalThis */
const encoder = new TextEncoder();
const MAX_TEXT_BYTES = 1024 * 1024;
const RSA = { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const runtime = () => {
  if (!globalThis.crypto?.subtle) throw new Error('Secure Web Crypto is required');
  return globalThis.crypto;
};
const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
export const toBase64 = value => {
  const data = bytes(value);
  let result = '';
  for (let i = 0; i < data.length; i += 8192) result += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(result);
};
export const fromBase64 = value => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
};
export const sha256 = async value => '0x' + Array.from(new Uint8Array(await runtime().subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value)), b => b.toString(16).padStart(2, '0')).join('');
export const normalizeContext = context => {
  if (!context || !Number.isSafeInteger(Number(context.chainId)) || Number(context.chainId) <= 0) throw new Error('Invalid chain');
  const address = value => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value || '') || /^0x0{40}$/i.test(value)) throw new Error('Invalid context address');
    return value.toLowerCase();
  };
  if (!/^0x[0-9a-fA-F]{64}$/.test(context.nonce || '') || /^0x0{64}$/i.test(context.nonce)) throw new Error('Invalid payload nonce');
  return { chainId: Number(context.chainId), factory: address(context.factory), seller: address(context.seller), nonce: context.nonce.toLowerCase() };
};
const aad = context => encoder.encode(JSON.stringify({ version: 1, ...normalizeContext(context) }));
export const randomNonce = () => '0x' + Array.from(runtime().getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export const generateDeliveryKey = () => runtime().subtle.generateKey(RSA, false, ['encrypt', 'decrypt']);
export const exportPublicKey = async key => toBase64(await runtime().subtle.exportKey('spki', key));
export const importPublicKey = async encoded => {
  const key = await runtime().subtle.importKey('spki', fromBase64(encoded), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
  if (key.algorithm.modulusLength !== 3072 || Array.from(key.algorithm.publicExponent).join(',') !== '1,0,1') throw new Error('RSA-3072 key required');
  return key;
};
export const fingerprintPublicKey = async encoded => {
  await importPublicKey(encoded);
  return sha256(fromBase64(encoded));
};
export const wrapKey = async (raw, publicKey) => {
  const data = bytes(raw);
  if (data.length !== 32) throw new Error('AES-256 key required');
  const key = typeof publicKey === 'string' ? await importPublicKey(publicKey) : publicKey;
  return toBase64(await runtime().subtle.encrypt({ name: 'RSA-OAEP' }, key, data));
};
export const unwrapKey = async (wrapped, privateKey) => {
  const raw = new Uint8Array(await runtime().subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromBase64(wrapped)));
  if (raw.length !== 32) throw new Error('Invalid unwrapped key');
  return raw;
};
export const sealText = async (text, context, kmsPublicKey) => {
  if (typeof text !== 'string') throw new Error('Text is required');
  const plain = encoder.encode(text);
  if (!plain.length || plain.length > MAX_TEXT_BYTES) throw new Error('Text must contain 1 to 1048576 UTF-8 bytes');
  const normalized = normalizeContext(context);
  const raw = runtime().getRandomValues(new Uint8Array(32));
  try {
    const key = await runtime().subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = runtime().getRandomValues(new Uint8Array(12));
    const ciphertext = await runtime().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(normalized), tagLength: 128 }, key, plain);
    const envelope = { version: 1, context: normalized, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
    return { envelope, wrappedKey: await wrapKey(raw, kmsPublicKey), ciphertextHash: await sha256(JSON.stringify(envelope)) };
  } finally {
    raw.fill(0);
    plain.fill(0);
  }
};
export const openEnvelope = async (envelope, rawKey, expectedContext = envelope?.context, expectedHash) => {
  if (envelope?.version !== 1 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > (MAX_TEXT_BYTES + 16) * 4 / 3 + 4) throw new Error('Invalid encrypted envelope');
  const actual = normalizeContext(envelope.context);
  const expected = normalizeContext(expectedContext);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Payload context mismatch');
  if (expectedHash && await sha256(JSON.stringify(envelope)) !== expectedHash.toLowerCase()) throw new Error('Ciphertext hash mismatch');
  const iv = fromBase64(envelope.iv);
  const raw = bytes(rawKey);
  if (iv.length !== 12 || raw.length !== 32) throw new Error('Invalid encryption parameters');
  const key = await runtime().subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await runtime().subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(actual), tagLength: 128 }, key, fromBase64(envelope.ciphertext));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(plain); }
  finally { new Uint8Array(plain).fill(0); }
};
