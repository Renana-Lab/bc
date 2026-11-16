import { useEffect, useRef } from "react";
import { isAddress } from "ethers";
import { getTargetNetwork } from "../sapphireNetworks";
import { getWalletScopeOverride, isInvisibleWalletMode } from "./walletMode.mjs";
import { createAutoWithdraw } from "./autoWithdraw.mjs";
import { createSweepController } from "./autoSweep.mjs";
import { beaconSweep, fetchSweepConfig, pidHashFor, postSweep } from "./sweepClient.mjs";

// Invisible companion of the local wallet. Draws nothing and says nothing.
//  * Auto-withdraw: claims refunds / deferred seller payments of auctions that closed (no button).
//  * Auto-return: keeps a pre-signed transfer of the leftover balance with the faucet server (see autoSweep.mjs).
// Only runs for the invisible local wallet of a participant: never in MetaMask mode, never with the admin override
// or the admin key slot, and never for an admin address.
const CONFIG_RETRY_MS = 30_000;
const CONFIG_ATTEMPTS = 4;

// Loaded on first use: the web3 stack is only needed once an auction closes.
const campaignAt = async (address) => (await import("../campaign")).default(address);

const readAuctionState = async (address, account) => {
  const auction = (await campaignAt(address)).methods;
  const [closed, cancelled, manager, status, sellerOwed] = await Promise.all([
    auction.getStatus().call(), auction.cancelled().call(), auction.manager().call(),
    auction.getUserAuctionStatus(account).call(), auction.sellerOwed().call(),
  ]);
  return {
    closed: Boolean(closed), cancelled: Boolean(cancelled), manager,
    participated: Boolean(status[0]), bid: BigInt(status[1] || 0), isHighestBidder: Boolean(status[4]), sellerOwed: BigInt(sellerOwed || 0),
  };
};

const AutoSweepHost = ({ wallet, provider, address, faucetUrl, strictPid, openPid, isAdmin = false }) => {
  const withdrawRef = useRef(null);
  const enabled = Boolean(wallet && provider && address && !isAdmin && isInvisibleWalletMode() && getWalletScopeOverride() !== "admin");

  useEffect(() => {
    if (!enabled) return undefined;
    const handle = createAutoWithdraw({
      getAccount: () => address,
      readState: readAuctionState,
      withdrawRefund: async (auction, account) => (await campaignAt(auction)).methods.withdrawRefund().send({ from: account }),
      withdrawSeller: async (auction, account) => (await campaignAt(auction)).methods.withdrawSellerPayment().send({ from: account }),
    });
    withdrawRef.current = handle;
    return () => { handle.stop(); withdrawRef.current = null; };
  }, [enabled, address]);

  useEffect(() => {
    if (!enabled || !faucetUrl || !(strictPid || openPid)) return undefined;
    let cancelled = false;
    let controller = null;
    let retryTimer = null;
    const network = getTargetNetwork();
    const start = async (attempt) => {
      const config = await fetchSweepConfig({ faucetUrl });
      if (cancelled) return;
      if (!config) {
        if (attempt + 1 < CONFIG_ATTEMPTS) retryTimer = setTimeout(() => start(attempt + 1), CONFIG_RETRY_MS);
        return;
      }
      const sweepAddress = process.env.REACT_APP_SWEEP_ADDRESS || process.env.REACT_APP_FAUCET_ADDRESS || config.sweepAddress;
      const pidHash = pidHashFor({ strictPid, openPid, pidMode: config.pidMode });
      if (!sweepAddress || !isAddress(sweepAddress) || !pidHash || config.chainId !== network.chainId) return;
      const read = (method, params) => provider.request({ method, params });
      controller = createSweepController({
        address, sweepAddress, chainId: network.chainId, pidHash,
        readBalance: async () => BigInt(await read("eth_getBalance", [address, "latest"])),
        readNonce: async () => Number(BigInt(await read("eth_getTransactionCount", [address, "pending"]))),
        readGasPrice: async () => BigInt(await read("eth_gasPrice", [])),
        signTransfer: (request) => wallet.signTransaction(request),
        signMessage: (message) => wallet.signMessage(message),
        // Pending refunds / seller payments are withdrawn first, so the participant is never left without gas for them.
        beforeSign: async () => (withdrawRef.current ? withdrawRef.current.drain({ waitForObservationMs: 20_000 }) : true),
        post: (path, payload) => postSweep({ faucetUrl, path, payload }),
        beacon: (path, payload) => beaconSweep({ faucetUrl, path, payload }),
      });
    };
    start(0);
    return () => { cancelled = true; clearTimeout(retryTimer); controller?.dispose(); };
  }, [enabled, address, faucetUrl, strictPid, openPid, wallet, provider]);

  return null;
};

export default AutoSweepHost;
