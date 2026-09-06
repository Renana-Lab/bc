import { discoverWalletProvider, requireWalletAccess, getWalletAccess } from "./walletAccess";

const WRITES = new Set(["eth_sendTransaction", "eth_signTransaction", "eth_sendRawTransaction", "eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4"]);

export const createWalletTransport = (fallback) => ({
  send(payload, callback) {
    const execute = async (request) => {
      let provider;
      if (WRITES.has(request.method)) {
        const session = await requireWalletAccess();
        if (getWalletAccess() !== session || discoverWalletProvider() !== session.provider) {
          throw new Error("Wallet access changed. Verify your connection and retry.");
        }
        provider = session.provider;
        const from = request.params?.[0]?.from;
        if (from && from.toLowerCase() !== session.account.toLowerCase()) {
          throw new Error("The wallet account changed. Review and resubmit your transaction.");
        }
      } else provider = discoverWalletProvider();
      if (provider) return { jsonrpc: "2.0", id: request.id, result: await provider.request({ method: request.method, params: request.params || [] }) };
      return new Promise((resolve, reject) => fallback.send(request, (error, result) => error ? reject(error) : resolve(result)));
    };
    (Array.isArray(payload) ? Promise.all(payload.map(execute)) : execute(payload)).then(
      (result) => callback(null, result), (error) => callback(error));
  },
});
