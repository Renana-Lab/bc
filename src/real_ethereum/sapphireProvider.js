import { wrapEthereumProvider } from "@oasisprotocol/sapphire-paratime";

// Wrap an EIP-1193 provider (MetaMask) so eth_call, eth_estimateGas and
// transactions carry encrypted calldata on Sapphire. Cached per provider.
const wrapped = new WeakMap();

export const getSapphireProvider = (provider) => {
  if (!provider) return provider;
  if (!wrapped.has(provider)) wrapped.set(provider, wrapEthereumProvider(provider));
  return wrapped.get(provider);
};
