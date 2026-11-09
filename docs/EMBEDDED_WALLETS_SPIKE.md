# Embedded wallets on Sapphire: spike results

Branch `spike/embedded-wallets-sapphire` (local only, based on `feat/sapphire-confidential-marketplace`).
Localnet only (`ghcr.io/oasisprotocol/sapphire-localnet`, chain 23293). Nothing was pushed or sent to a public chain.

**Scope change:** Apillon was dropped (service shut down on 2026-01-01 per the project owner). There is no `@apillon/*`
dependency, no `REACT_APP_APILLON_CLIENT_ID`, and `REACT_APP_WALLET_MODE` accepts only `metamask | privy | local`.

## How it works

`REACT_APP_WALLET_MODE` (default `metamask`, unchanged flow) selects the wallet. Every mode produces a **raw EIP-1193
provider** that is only ever reached through `getSapphireProvider()` -> `wrapForSapphire()`
(`src/real_ethereum/wallets/sapphireWrap.mjs`):

```
app (web3.js / personal_sign) -> paratime wrapper (encrypts calldata) -> guard -> raw wallet provider
```

* The Sapphire paratime wrapper encrypts `data` of `eth_sendTransaction`, `eth_call`, `eth_estimateGas`.
* The guard sits **under** the wrapper and throws if a transaction/call still carries plaintext calldata (`data` or
  `input`), rejects `eth_sendRawTransaction` with plaintext calldata, `wallet_sendCalls` and `eth_sendUserOperation`.
  The only plaintext call allowed is the wrapper's own public calldata-key query. Finding while building this: the
  wrapper only encrypts `params[0].data`, so a caller passing `input` would have skipped encryption; the guard closes that.
* The local wallet provider additionally refuses to sign plaintext calldata itself.
* Privy hooks that send transactions on their own (`useSendTransaction`, `wallet.sendTransaction`) are not used.
* SIWE (`personal_sign` -> `factory.login` -> `getDataWithToken`) is unchanged and works with every mode.

## Results per mode

| | MetaMask (default) | Privy | Local (browser keystore) |
|---|---|---|---|
| 1. Bid calldata encrypted (localnet) | **Yes**: recorder saw only enveloped `data`; on-chain tx `isCalldataEnveloped` = true | **Yes** with a *simulated* Privy-style raw provider; real Privy login **pending** (manual) | **Yes**: real local wallet implementation, same evidence |
| 2. SIWE + `getDataWithToken` | Winner reads payload; other mode wallets denied | Same (simulated); real popup flow pending | Same |
| 3. Gas, zero-balance bid | Needs funds | Needs funds (Privy does not sponsor on a custom localnet chain here) | Needs funds |
| 4. Recovery | Seed phrase in MetaMask | Log in with email on any browser (per Privy docs, not verified here) | Same browser + passphrase: yes. Cleared site data: key gone unless the encrypted backup file was downloaded. Other browser: only via backup + passphrase |
| 5. Custody | User's extension | Privy-hosted wallet infrastructure (key sharded; exportable per Privy docs). Privy account/app dependency | Key encrypted (scrypt + AES keystore) in this browser's IndexedDB, decrypted in memory only while unlocked; never sent anywhere |

Automated evidence: `scripts/sapphire/walletModes.test.mjs` (localnet). It also proves the bypass checks (guard refuses
plaintext via `data`, `input`, raw tx, `wallet_sendCalls`; refused requests never reach the wallet) and that the local
provider/wallet never return key material.

Local mode note: the request asked for `ethers.Wallet` + `wrapEthersSigner`. The app talks to wallets through EIP-1193
(web3.js), so the local wallet is an EIP-1193 provider around an `ethers.Wallet` and is wrapped by
`wrapEthereumProvider` (same Sapphire encryption library). `wrapEthersSigner` is exercised by the existing suites for
the seller/faucet accounts, not for the local wallet itself.

## Gas / gasless feasibility (Oasis `EIP155Signer`, localnet only)

Test: `scripts/sapphire/gasless/gaslessFeasibility.test.mjs` with test-only contracts in
`scripts/sapphire/gasless/GaslessFeasibility.sol` (the marketplace contracts are untouched).

* **Works:** a contract-held keypair signs a tx (confidential view call); a participant with **zero balance** broadcasts
  it; the calldata in that signed tx is a Sapphire envelope; replaying it fails.
* **Problems for this marketplace:**
  1. `msg.sender` at the target is the proxy contract, not the participant. `Campaign.contribute()` uses `msg.sender`
     as the bidder, and `getDataWithToken` authenticates an address, so every bidder would be the proxy and nobody
     could be the identifiable winner. Fixing it means changing `Campaign` (trusted-forwarder `_msgSender()` with a
     user signature), which was out of scope.
  2. A bid is native value. The relayer paid gas **and** the bid amount, so "no coins" also means the app funds bids.
  3. The base pattern has no per-user authorization: anyone can request a signed tx and drain the relayer within the
     fixed gas limit; single relayer nonce (one tx per block per signer) needs a signer pool.
* **Conclusion:** not usable as-is. The lab PoC should use a localnet/testnet **faucet funding step** (a small top-up
  per participant). Gasless could be revisited only together with a forwarder-aware `Campaign` and a funded-bid policy.

## Manual checklists (need Yair; nothing below has been performed yet)

Prerequisites: localnet running, factory deployed (`.env` has `REACT_APP_FACTORY_ADDRESS`, git-ignored),
`REACT_APP_NETWORK=sapphire-localnet`, app origin `http://localhost:3000`. Fund each test account on localnet only.

**Local mode** (`REACT_APP_WALLET_MODE=local npm start`)
1. Open http://localhost:3000. Expect a "Local wallet (spike)" box bottom-right.
2. Enter a passphrase (8+ chars), click Create. Expect "Unlocked: 0x...". Copy the address; fund it on localnet.
3. Create/bid on an auction. Expect no MetaMask; bid succeeds; the explorer/RPC shows enveloped calldata.
4. After the auction closes as the winner, open the auction page. Expect the payload without any prompt (the local wallet signs SIWE silently).
5. Click Lock. Expect the payload hidden again; Unlock restores it. Reload: wallet still exists, locked.
6. Download encrypted backup; click Forget; reload. Expect a fresh "Create" state and the old payload unreadable.

**Privy mode** (`REACT_APP_WALLET_MODE=privy npm start`; app id is read from `.env`)
1. Open http://localhost:3000. Expect "Privy wallet (spike)" -> click "Log in with email".
2. Enter your email, then the code you receive (yours to do). Expect "Account: 0x..." shortly after.
3. Fund that address on localnet. Place a bid. Expect a Privy confirmation modal (calldata shown is an opaque envelope), then success.
4. As winner after close: expect one Privy sign prompt (SIWE message) and then the payload. A second read within an hour: no prompt.
5. Log out. Expect the payload hidden. Open a different browser, log in with the same email: same address (recovery).

Report each as passed only after you did it.

## Known limits

* Real Privy (login, modals, `getEthereumProvider` behavior on a custom chain) was not run live.
* `@privy-io/react-auth` adds a lazy ~1.7 MB chunk (loaded only in privy mode); install used `--ignore-scripts`
  because an optional native module (`bufferutil`) fails to build on Windows/Node 24.
* A Privy transaction modal and the `showWalletUIs` setting were left at defaults.
