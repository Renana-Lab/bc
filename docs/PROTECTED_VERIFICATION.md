# Marketplace Protected Verification

Date: 2026-11-08. Base: `222f22e`. This is a testnet preview, not a completed
independent security audit or real-Mac certification.

## Live Evidence

- Factory: `0xc52f7A33010E525dcC1821F533e96B381C3879c2` on Sepolia.
- Auction: `0x883b9A86Cd396d223bd60877CB3E08712EEbB22c`.
- Creation: `0xe761675a6d34b6259e68620e4b86fe4d3b2948d0effefbf9ddbaf1a82da1f256`.
- Bid: `0x41b8388f5177b8ca4183bbaea8a93a9e032d3dfdb7c18e9a4390c11501651c45`.
- A new-device winner key decrypted the exact dummy marker through real AWS KMS,
  private S3 and the confirmed chain. No seller action/key was used for release.
- Unrelated wallet denied; session replay denied; recipient-key substitution
  denied; signed S3 upload with a mismatched Content-Length denied.
- Marker absent from creation calldata, public contract summary and ciphertext.
- All 202 legacy records were imported and traversed in five API pages without
  duplicates. An original winning wallet decrypted its archived content and
  matched the original payload hash; an unrelated wallet was denied.
- Real deployed Chromium and WebKit checks decrypted through the UI, then cleared
  plaintext when the test wallet locked. They used an automated EIP-6963 signer
  adapter, NOT the MetaMask extension. That distinction is an open manual gate.
- Ten warm release samples after adding another RPC fallback had p95 1,121 ms.
  A first view on a new device took roughly 4.4-5.1 seconds including RSA generation,
  session authentication and downloading/decrypting. Warm API timing is not a
  measurement of the entire new-device flow or a controlled cold Lambda start.

## Automated Coverage

- Full CRA Jest suite: 17 suites / 132 tests passed.
- Protected Node suite: 59 tests passed, covering crypto, contracts, service, archive, client retries,
  DynamoDB conditions, finalizer postconditions, batching and stress.
- Existing Node market/bot/experiment regressions: 75 tests passed.
- Existing local-contract stress: 22 invariant groups, 32 auctions and 30 parallel
  bots passed. Protected stress separately created 50 real local auctions, funded
  100 bot wallets, and mined 50 distinct bids; 1,000 historical records were index
  fixtures, not 1,000 additional live Sepolia transactions.
- Browser worker tests passed in Chromium/WebKit: nonexportable persisted keys,
  AES/RSA round trips, session reuse, upload retry reuse and revocation.
- CRA production build and Vite protected production build passed. Legacy
  Solidity source/artifacts remain unchanged.

## Performance

A deterministic 20-row list benchmark used identical RPC fixtures and the balanced
motion profile against an isolated build of `222f22e`. The last unloaded run
measured median search 23.56/25.73 ms in Chromium and 54.86/57.14 ms in WebKit
(baseline/protected), changes of +9.2% and +4.1%. Neither mode made key-service
requests during ordinary list interaction. Main-index gzip grew from 92,257 to
92,482 bytes. Earlier simultaneous-build/test runs were noisy and exceeded 10%;
these figures are not a cross-device performance guarantee or Lighthouse result.
Local gas tests measured creation +4.0% and first bid +4.3% versus the legacy
contract with the same compiler/EVM settings. Gas is not wall-clock latency.

## Remaining Gates And Limits

- Actual macOS Chrome + real MetaMask: locked, missing extension, disconnected,
  normal trading and winning-data recovery must be checked manually.
- Controlled cold-start p95 and repeated quiet-machine trading latency need
  additional measurements before asserting every performance target is met.
- New data is encrypted; original historical calldata/storage cannot be erased.
- AWS operators with sufficient KMS/data permissions can recover keys; recipients
  can copy decrypted information. This is not a zero-knowledge or DRM system.
- Public RPCs have outages/capacity/pruned-state limits. Configure an authenticated
  provider via Secrets Manager for dependable experiments; failures block release.
- Inherited business rules were preserved, including public global-budget reset
  (previously explicitly retained) and reverting smart-contract payment recipients.
  The finalizer rotates past failures so one failed auction does not starve others.
- Source changes for the separate backend variant are not deployed by this app.

Reproduction commands and resource links are in `MARKETPLACE_PROTECTED.md` and
`PROTECTED_ARCHIVE.md`. Ignored runtime reports contain public outcomes only;
private smoke-test wallet state and generated delivery keys must never be committed.
