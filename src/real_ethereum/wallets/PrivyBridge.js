import React, { useEffect, useMemo, useState } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { setModeProvider } from "./modeProvider";
import { getTargetNetwork } from "../sapphireNetworks";
import { clearConfidentialSessions } from "../confidentialData";

// Mode "privy": Privy embedded wallet on the configured Sapphire network (custom EVM chain).
// Privy only SIGNS/BROADCASTS. The EIP-1193 provider it exposes is registered as the RAW mode
// provider; the app always reaches it through getSapphireProvider() (guard + Sapphire wrapper),
// so calldata is encrypted before Privy sees it. Privy hooks that send transactions themselves
// (useSendTransaction, wallet.sendTransaction) are deliberately NOT used anywhere.
const chainFor = (network) =>
  defineChain({
    id: network.chainId,
    name: network.chainName,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: network.rpcUrls } },
  });

const Session = ({ network, boxStyle }) => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [error, setError] = useState("");
  const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");

  useEffect(() => {
    let cancelled = false;
    if (!ready || !authenticated || !embedded) {
      setModeProvider(null);
      return undefined;
    }
    (async () => {
      await embedded.switchChain(network.chainId);
      const provider = await embedded.getEthereumProvider();
      if (!cancelled) setModeProvider(provider);
    })().catch((failure) => {
      if (cancelled) return;
      setModeProvider(null);
      setError(`Privy wallet unavailable on ${network.chainName}: ${failure?.message || "unknown error"}`);
    });
    return () => { cancelled = true; };
  }, [ready, authenticated, embedded?.address, network.chainId]);

  return (
    <div style={boxStyle} data-testid="privy-wallet-panel">
      <strong>Privy wallet (spike)</strong>
      {error ? <div role="alert">{error}</div> : null}
      {!ready ? <div>Loading…</div> : authenticated ? (
        <>
          <div style={{ wordBreak: "break-all" }}>{embedded ? `Account: ${embedded.address}` : "Creating wallet…"}</div>
          <button onClick={async () => { setModeProvider(null); clearConfidentialSessions(); await logout(); }}>Log out</button>
        </>
      ) : (
        <button onClick={login}>Log in with email</button>
      )}
    </div>
  );
};

const PrivyBridge = ({ boxStyle }) => {
  const appId = process.env.REACT_APP_PRIVY_APP_ID;
  const network = getTargetNetwork();
  const chain = useMemo(() => chainFor(network), [network]);
  if (!appId) {
    return <div style={boxStyle}>Privy mode needs REACT_APP_PRIVY_APP_ID in .env.</div>;
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        defaultChain: chain,
        supportedChains: [chain],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      <Session network={network} boxStyle={boxStyle} />
    </PrivyProvider>
  );
};

export default PrivyBridge;
