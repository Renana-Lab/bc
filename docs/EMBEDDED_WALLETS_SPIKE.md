# Embedded wallets on Sapphire: spike results

Branch `spike/embedded-wallets-sapphire` (local only, based on `feat/sapphire-confidential-marketplace`).
Localnet only (`ghcr.io/oasisprotocol/sapphire-localnet`, chain 23293). Nothing was pushed or sent to a public chain.

## Decision

* **Apillon** was dropped: the service shut down on 2026-01-01. No `@apillon/*` code or dependency remains.
* **Privy** was evaluated and works technically, but is **rejected because it requires an email address** and the experiment
  needs full participant anonymity. All Privy code, packages (`@privy-io/*`, `viem`, `@stripe/stripe-js`) and configuration were removed.
* **Going forward: `local` wallet only**, MetaMask stays the default. `REACT_APP_WALLET_MODE` accepts `metamask | local`;
  any other value (including `privy`, `apillon`) throws.

What the Privy evaluation showed (kept for the record; nothing of it remains in the code):

* Login, embedded wallet creation and reload (session persisted): worked.
* The signing window "Approve transaction" showed network "Oasis Sapphire Localnet" and the auction address (it cannot decode the call).
* A bid executed; the on-chain bid tx had enveloped calldata (234 chars, `isCalldataEnveloped` true, no plaintext selector).
* The SIWE "Sign message" window showed the message for `localhost:3000`, chain ID 23293; after signing, the payload was shown.
* A gas problem had to be worked around: Privy ignored the 100 gwei `gasPrice` we passed and chose its own fee, which Sapphire
  rejected ("gas price too low"). Signing with `eth_signTransaction` and broadcasting ourselves fixed it. That fix was not committed.

## How it works

`REACT_APP_WALLET_MODE` (default `metamask`, unchanged flow) selects the wallet. The wallet produces a **raw EIP-1193
provider** that is only ever reached through `getSapphireProvider()` -> `wrapForSapphire()`
(`src/real_ethereum/wallets/sapphireWrap.mjs`):

```
app (web3.js / personal_sign) -> paratime wrapper (encrypts calldata) -> guard -> raw wallet provider
```

* The Sapphire paratime wrapper encrypts `data` of `eth_sendTransaction`, `eth_call`, `eth_estimateGas`.
* The guard sits **under** the wrapper and throws if a transaction/call still carries plaintext calldata (`data` or `input`), rejects
  `eth_sendRawTransaction` with plaintext calldata, and rejects methods that can carry calldata but cannot be encrypted
  (`wallet_sendCalls`, `eth_sendUserOperation`, `eth_createAccessList`, `debug_traceCall`, `eth_simulateV1`, `eth_callMany`).
  The only plaintext call allowed is the wrapper's own public calldata-key query. The wrapper itself only encrypts `params[0].data`,
  so a caller passing `input` would have skipped encryption; the guard closes that.
* The guard checks envelope *format* (`isCalldataEnveloped`): it prevents accidental plaintext, it does not prove ciphertext quality.
* The local wallet provider applies the same check to everything it signs or forwards.
* Before a wallet session exists, public reads use the plain fallback RPC transport, like MetaMask-absent behavior; writes need a verified wallet.
* SIWE (`personal_sign` -> `factory.login` -> `getDataWithToken`) is unchanged.

## Local wallet

* A key generated in the browser, stored as an encrypted keystore (scrypt N=2^17 + AES) in IndexedDB, unlocked with a passphrase
  (12+ chars). The decrypted key is held in memory while unlocked (JS cannot zero it on lock) and is never sent anywhere or logged.
  The unlocked wallet signs without per-transaction confirmation (spike only).
* A page reload locks it again (passphrase needed). Clearing site data deletes the key unless the encrypted backup was downloaded.
* **Recovery:** "Download encrypted backup" + "Restore from backup" (same passphrase). The panel tells participants not to clear site data during the session.
* **Verified in a real browser** (`scripts/sapphire/e2e/localWalletE2E.mjs`, Playwright, localnet): create wallet, fund from a localnet
  dev account, bid through the UI, on-chain bid calldata enveloped, winner reads the payload (SIWE signed silently), loser denied,
  backup download, site data cleared (wallet gone, payload unreadable), restore (same address, payload readable again).
* Automated localnet checks without a browser: `scripts/sapphire/walletModes.test.mjs` (MetaMask-style simulated provider + real local wallet):
  encrypted calldata, SIWE read by winner only, bypass attempts refused, recovery, key hygiene (key never logged, never in backups).

## Anonymous participant code and protected faucet (design + localnet stub)

* **Participant code:** the lab hands out a random code in the link, `http://.../?pid=K7f3QpX9mA2d` (8-24 letters/digits). The app reads it
  from the URL and keeps it in `sessionStorage` only (`participantId.mjs`). The format check rejects anything that looks like an
  email or phone number. No email, phone or name is collected anywhere.
* **Faucet policy (stub: `faucetStub.mjs`, `scripts/sapphire/faucetServer.mjs`, localnet only):** a fixed amount per participant code,
  **once**, and once per address; the table stores only SHA-256 digests of codes. An optional allowlist of digests restricts who may claim.
  Concurrent claims for one code pay once; failed sends can be retried.
* **Not in the stub, needed for a real deployment:**
  * The funding key lives only in server-side secret storage (never in the repo, the browser or this stub; the stub uses the public
    localnet dev phrase and refuses non-local RPCs).
  * Persistent store for claims, rate limiting, request size limits, and monitoring of the faucet balance.
  * The lab can link a code to an address (pseudonymous, not anonymous towards the lab). If participants must be unlinkable even from
    the lab, use blind/one-time tokens instead of the code-to-address mapping.
  * Codes should be single-use and distributed out of band.
* The panel shows the code and a "Request test funds" button only when `REACT_APP_FAUCET_URL` is set (the localnet stub).

## Gas / gasless feasibility (Oasis `EIP155Signer`, localnet only)

Test: `scripts/sapphire/gasless/gaslessFeasibility.test.mjs` with test-only contracts in
`scripts/sapphire/gasless/GaslessFeasibility.sol` (the marketplace contracts are untouched).

* **Works:** a contract-held keypair signs a tx (confidential view call); a participant with **zero balance** broadcasts it; the calldata
  of that signed tx is a Sapphire envelope; replaying it fails.
* **Problems for this marketplace:**
  1. `msg.sender` at the target is the proxy contract, not the participant. `Campaign.contribute()` uses `msg.sender` as the bidder and
     `getDataWithToken` authenticates an address, so every bidder would be the proxy and nobody could be the identifiable winner.
     Fixing it means changing `Campaign` (trusted-forwarder `_msgSender()` with a user signature), which was out of scope.
  2. A bid is native value. The relayer paid gas **and** the bid amount, so "no coins" also means the app funds bids.
  3. The base pattern has no per-user authorization: anyone can request a signed tx and drain the relayer within the fixed gas limit;
     a single relayer nonce (one tx per block per signer) needs a signer pool.
* **Conclusion:** not usable as-is. Use the faucet step above. Revisit gasless only together with a forwarder-aware `Campaign` and a funded-bid policy.

## Manual check (local mode, optional; the browser E2E already covers it)

`REACT_APP_NETWORK=sapphire-localnet REACT_APP_WALLET_MODE=local npm start`, open `http://localhost:3000/?pid=K7f3QpX9mA2d`:
create a wallet (passphrase 12+ chars), fund the shown address (faucet stub or a localnet dev account), bid, and after the auction
closes click "View data". Lock/Unlock, download the backup, forget, and restore.

## Known limits

* Real MetaMask was not driven in this spike; the MetaMask rows in the automated tests use a simulated provider.
* The unlocked local wallet signs without confirmations: not for real funds. XSS on the origin can spend and sign.
* The wallet check pauses while the browser tab is hidden (existing behavior).
