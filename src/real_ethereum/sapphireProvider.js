import { wrapForSapphire } from "./wallets/sapphireWrap.mjs";

// Wrap an EIP-1193 provider (MetaMask, or an embedded wallet in another REACT_APP_WALLET_MODE) so
// eth_call, eth_estimateGas and transactions carry encrypted calldata on Sapphire. The wrapper is
// preceded by a guard that rejects plaintext calldata. Cached per provider.
const wrapped = new WeakMap();

export const getSapphireProvider = (provider) => {
  if (!provider) return provider;
  if (!wrapped.has(provider)) wrapped.set(provider, wrapForSapphire(provider));
  return wrapped.get(provider);
};
