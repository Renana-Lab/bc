import { useEffect, useRef } from "react";
import { isAddress } from "ethers";
import { getTargetNetwork } from "../sapphireNetworks";
import { getWalletScopeOverride, isInvisibleWalletMode } from "./walletMode.mjs";
import { createAutoWithdraw } from "./autoWithdraw.mjs";
import { createSweepController } from "./autoSweep.mjs";
import { observeAuctions } from "../auctionObserver.mjs";
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
  const loaderRef = useRef(null);
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
    // The host looks at the participant's auctions itself (it does not depend on the auctions list having been opened).
    // The first call starts at once; later calls (every signature, so about every 10 minutes) refresh the picture.
    let loading = null;
    let lastLoadAt = 0;
    loaderRef.current = async () => {
      if (!loading && Date.now() - lastLoadAt < 60_000 && lastLoadAt) return true;
      if (!loading) {
        loading = import("./participantAuctions").then(({ loadParticipantAuctions }) => loadParticipantAuctions({ account: address }))
          .then((auctions) => { lastLoadAt = Date.now(); observeAuctions(auctions, address); return true; })
          .catch(() => false) // an unreadable list is not "nothing to withdraw"
          .finally(() => { loading = null; });
      }
      return loading;
    };
    loaderRef.current();
    return () => { handle.stop(); withdrawRef.current = null; loaderRef.current = null; };
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
      // The server decides what it accepts: its address wins. The build-time values are only a fallback, and a
      // difference is worth a console warning (an operator mistake, never shown to participants).
      const configured = [process.env.REACT_APP_SWEEP_ADDRESS, process.env.REACT_APP_FAUCET_ADDRESS].filter(Boolean);
      const sweepAddress = config.sweepAddress || configured[0];
      if (config.sweepAddress && configured.some((value) => String(value).toLowerCase() !== String(config.sweepAddress).toLowerCase())) {
        console.warn("[sweep] The configured address differs from the faucet server's sweep address; using the server's.");
      }
      // Signature timestamps use the server's clock (a participant's clock may be minutes off).
      const clockOffset = Number.isFinite(config.serverTime) ? config.serverTime - Date.now() : 0;
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
        now: () => Date.now() + clockOffset,
        // Pending refunds / seller payments are withdrawn first, so the participant is never left without gas for them.
        beforeSign: async () => {
          if (!withdrawRef.current || !loaderRef.current) return true;
          if (!(await loaderRef.current())) return false; // the auction list could not be read: do not sweep blindly
          return withdrawRef.current.drain();
        },
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
