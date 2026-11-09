// Oasis Sapphire network definitions for the wallet and RPC layers.
// Sapphire Mainnet (23294) is intentionally not configured here.
export const SAPPHIRE_NETWORKS = {
  "sapphire-testnet": {
    id: "sapphire-testnet",
    chainId: 23295,
    chainIdHex: "0x5aff",
    chainName: "Oasis Sapphire Testnet",
    rpcUrls: ["https://testnet.sapphire.oasis.io"],
    blockExplorerUrls: ["https://explorer.oasis.io/testnet/sapphire"],
    nativeCurrency: { name: "TEST", symbol: "TEST", decimals: 18 },
  },
  // Local development only (docker image oasisprotocol/sapphire-localnet).
  "sapphire-localnet": {
    id: "sapphire-localnet",
    chainId: 23293,
    chainIdHex: "0x5afd",
    chainName: "Oasis Sapphire Localnet",
    rpcUrls: ["http://localhost:8545"],
    blockExplorerUrls: [],
    nativeCurrency: { name: "TEST", symbol: "TEST", decimals: 18 },
  },
};

export const DEFAULT_NETWORK_ID = "sapphire-testnet";

export const getTargetNetwork = () => {
  const id = String(process.env.REACT_APP_NETWORK || DEFAULT_NETWORK_ID)
    .trim()
    .toLowerCase();
  return SAPPHIRE_NETWORKS[id] || SAPPHIRE_NETWORKS[DEFAULT_NETWORK_ID];
};

const isChainMismatch = (current, network) =>
  String(current || "").toLowerCase() !== network.chainIdHex;

// Prompts MetaMask to switch to the configured Sapphire network, adding it first
// when the wallet does not know it yet (EIP-3085 / EIP-3326).
export const ensureTargetChain = async (provider, network = getTargetNetwork()) => {
  const current = await provider.request({ method: "eth_chainId" });
  if (!isChainMismatch(current, network)) return network;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainIdHex }],
    });
  } catch (error) {
    const code = error?.code ?? error?.data?.originalError?.code;
    if (code !== 4902) {
      if (code === 4001) {
        throw new Error(`Switch MetaMask to ${network.chainName} to continue.`);
      }
      throw error;
    }
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: network.chainIdHex,
          chainName: network.chainName,
          nativeCurrency: network.nativeCurrency,
          rpcUrls: network.rpcUrls,
          ...(network.blockExplorerUrls.length
            ? { blockExplorerUrls: network.blockExplorerUrls }
            : {}),
        },
      ],
    });
  }

  const after = await provider.request({ method: "eth_chainId" });
  if (isChainMismatch(after, network)) {
    throw new Error(`MetaMask is not on ${network.chainName}. Switch networks and retry.`);
  }
  return network;
};
