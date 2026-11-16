// Plain native-token transfers from the connected admin wallet (MetaMask, or the local admin wallet), used by the
// "Participants gas" and "Faucet funds" cards. Never automatic: callers only run after an explicit confirmation.
import { requireWalletAccess } from "../../real_ethereum/walletAccess";
import { ensureTargetChain, getTargetNetwork } from "../../real_ethereum/sapphireNetworks";
import { getSapphireProvider } from "../../real_ethereum/sapphireProvider";
import { readOnlyExecute } from "../../real_ethereum/readOnly";
import { toHexWei } from "../../real_ethereum/wallets/nativeBalance";
import { readNativeBalances } from "./participantsGasReaders";

export const sendNativeFromAdmin = async (to, valueWei) => {
  const session = await requireWalletAccess();
  await ensureTargetChain(session.provider);
  return getSapphireProvider(session.provider).request({
    method: "eth_sendTransaction",
    params: [{ from: session.account, to, value: toHexWei(valueWei) }],
  });
};

// true = mined successfully, false = mined but failed or not seen before the timeout.
export const waitForReceipt = async (hash, { timeoutMs = 90_000, intervalMs = 2000, read, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => {
  const fetchReceipt = read || ((txHash) => readOnlyExecute(({ web3 }) => web3.eth.getTransactionReceipt(txHash), undefined, { preferInjected: false, allowInjectedFallback: false }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let receipt = null;
    try { receipt = await fetchReceipt(hash); } catch { receipt = null; }
    if (receipt) return receipt.status === true || receipt.status === 1 || receipt.status === "0x1" || receipt.status === 1n;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
};

export const readAdminBalance = async (account) => {
  const balances = await readNativeBalances([account]);
  const value = balances[String(account).toLowerCase()];
  if (value === null || value === undefined) throw new Error("Admin balance unavailable");
  return value;
};

export const explorerTxUrl = (hash, network = getTargetNetwork()) => {
  const base = network.blockExplorerUrls?.[0];
  return base ? `${base.replace(/\/+$/, "")}/tx/${hash}` : "";
};

export const explorerAddressUrl = (address, network = getTargetNetwork()) => {
  const base = network.blockExplorerUrls?.[0];
  return base ? `${base.replace(/\/+$/, "")}/address/${address}` : "";
};
