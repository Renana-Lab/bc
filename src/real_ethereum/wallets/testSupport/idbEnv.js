// Test-only environment for the IndexedDB + WebCrypto wallet tests (Jest "node" environment).
// Real browsers provide all of this; Jest 27 does not.
const { webcrypto } = require("crypto");

if (typeof globalThis.DOMException === "undefined") {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message = "", name = "Error") { super(message); this.name = name; this.code = 0; }
  };
}
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

// Structured clone that keeps CryptoKey objects, as real IndexedDB does.
const clone = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (value.constructor?.name === "CryptoKey") return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
};
globalThis.structuredClone = clone;
