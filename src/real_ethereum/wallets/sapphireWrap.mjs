import { wrapEthereumProvider, isCalldataEnveloped, isCallDataPublicKeyQuery } from "@oasisprotocol/sapphire-paratime";
import { Transaction } from "ethers";

// The single choke point for every wallet mode. A raw EIP-1193 provider (MetaMask, Privy,
// local wallet) is first wrapped in a guard that REFUSES any transaction or call
// carrying plaintext calldata, and the guarded provider is then wrapped by the Sapphire
// paratime wrapper, which encrypts calldata before it reaches the guard. If the wrapper were
// ever skipped or a code path talked to the raw provider directly, the guard throws instead of
// silently sending the payload in cleartext.
const hasData = (data) => typeof data === "string" && data !== "0x" && data !== "";

export const assertEnvelopedCalldata = (data, context) => {
  if (hasData(data) && !isCalldataEnveloped(data)) {
    throw new Error(`Refusing to send plaintext calldata (${context}). All calls must pass through the Sapphire wrapper.`);
  }
};

const CALLDATA_METHODS = new Set(["eth_sendTransaction", "eth_signTransaction", "eth_call", "eth_estimateGas"]);
const UNSUPPORTED = new Set(["wallet_sendCalls", "eth_sendUserOperation"]);

export const assertRequestIsConfidential = ({ method, params }) => {
  if (UNSUPPORTED.has(method)) {
    throw new Error(`${method} is not supported: it cannot be encrypted by the Sapphire wrapper.`);
  }
  if (CALLDATA_METHODS.has(method)) {
    const tx = params?.[0] || {};
    // The wrapper fetches Sapphire's public calldata key with a plaintext eth_call; that query
    // carries no user data. Anything else must be enveloped. The wrapper only encrypts `data`,
    // so a caller using `input` would skip encryption: both fields are checked here.
    if (method === "eth_call" && isCallDataPublicKeyQuery(params)) return;
    assertEnvelopedCalldata(tx.data, method);
    assertEnvelopedCalldata(tx.input, method);
  } else if (method === "eth_sendRawTransaction") {
    assertEnvelopedCalldata(Transaction.from(params?.[0]).data, method);
  }
};

export const guardProvider = (raw) =>
  new Proxy(raw, {
    get(target, property) {
      if (property === "request") {
        return async (args) => {
          assertRequestIsConfidential(args);
          return target.request(args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export const wrapForSapphire = (raw) => wrapEthereumProvider(guardProvider(raw));
