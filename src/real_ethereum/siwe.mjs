// Sign-In with Ethereum (EIP-4361) helpers for Sapphire SiweAuth.
// The user signs once; the factory returns an encrypted bearer token that
// Campaign.getDataWithToken accepts until it expires.
export const SIWE_SESSION_MINUTES = 60;

/* global globalThis */
const randomNonce = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export const buildSiweMessage = ({
  domain,
  address,
  uri,
  chainId,
  now = new Date(),
  minutes = SIWE_SESSION_MINUTES,
  nonce = randomNonce(),
}) => {
  const expires = new Date(now.getTime() + minutes * 60 * 1000);
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to read the data you won in this marketplace.",
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${expires.toISOString()}`,
  ].join("\n");
};

// 65-byte 0x signature -> the {r, s, v} struct SiweAuth.login expects.
export const splitSignature = (signature) => {
  const hex = String(signature).replace(/^0x/, "");
  if (hex.length !== 130) throw new Error("Unexpected signature length");
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v };
};

export const utf8ToHex = (text) =>
  `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
