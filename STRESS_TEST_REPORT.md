# Blockchain Data Market Stress Test Report

Date: 2026-08-10

## Scope

This pass exercised the deployable React application, Solidity contracts, auction finalization automation, report generation, bot decision logic, wallet access gates, responsive boundaries, routing, and accessibility semantics. Blockchain writes were made only to disposable in-memory Ganache chains. No production auction or wallet was modified.

## Results

| Area | Load / scenarios | Result |
| --- | --- | --- |
| Solidity lifecycle | Global-budget behavior, invalid inputs, repeat bids, outbids, budget snapshots, finalization, seller payment, winner data, refunds | Pass |
| Contract contention | 31 auctions and 30 bot wallets submitting transactions concurrently | Pass, 19 invariant groups in 6.3s |
| Auto-finalizer | Exact production CLI against deployed local contracts; zero-bid, competitive, refund, active, and repeated-run cases | Pass in 5.6s |
| Bulk auction imports | 10,000 quoted CSV and malformed-input rows | Pass |
| Report engine | 5,000 concurrency-capped jobs and 500-auction exports, including zero-bid rows | Pass |
| Bot utilities | 1,000 private keys and 20,000 randomized bid decisions | Pass |
| Jest | All 7 suites | Pass, 37 tests |
| ESLint | All changed application, automation, test, and stress files | Pass |
| Solidity compiler | solc 0.8.35, optimizer enabled, Shanghai target | Pass |
| Production build | Optimized CRA build | Pass in 671.2s |
| Browser routes | Home, guide, unknown route, and four protected direct-entry routes | Pass |
| Responsive layout | 320, 375, 767, 768, 1024, and 1440 CSS pixels | Pass, no horizontal overflow |
| Accessibility | Named toolbar actions, H1/H2 guide structure, labeled fields, image alternatives | Pass for audited public pages |
| Production console | Public navigation on the final optimized bundle | Pass, no warnings or errors |

## Defects Fixed

1. **Invalid auctions accepted on-chain:** zero minimums, empty data, empty descriptions, and invalid durations are rejected by the contract.
2. **Unbounded finalization failure propagation:** a failed campaign could stop the factory finalization loop. Bounded range finalization and per-auction failure events were added.
3. **Undeployable normal compiler output:** `compile.js` emitted a roughly 25 KB unoptimized factory artifact that exhausted deployment limits. The real compiler now uses the tested optimizer configuration; factory creation bytecode is 13,371 bytes.
4. **Finalizer clock mismatch:** automation used runner wall time instead of blockchain time, which could leave ended auctions pending. It now uses the latest block timestamp.
5. **Bot state split-brain:** the hidden scheduler and visible admin panel could overwrite each other from stale React state. Both now synchronize through the latest stored bot state and state event.
6. **Report/import edge cases:** quoted CSV values, malformed rows, invalid timestamps, and a zero concurrency limit are handled safely.
7. **Blank unknown routes:** unmatched URLs now return to the marketplace entry screen.
8. **Accessibility gaps:** toolbar icon buttons are named and the MetaMask guide has a valid heading hierarchy.
9. **767 px breakpoint leak:** fractional device-pixel rounding could show the desktop experience at the mobile boundary. The breakpoint now uses `767.98px`.

## Repeatable Commands

```powershell
node src/real_ethereum/compile.js
node scripts/stress/contractStress.js
node scripts/stress/automationStress.js
node scripts/stress/utilityStress.js
node node_modules/react-scripts/bin/react-scripts.js test --watchAll=false --runInBand
node node_modules/react-scripts/bin/react-scripts.js build
```

## Remaining Risks

### Critical

- The current deployed factory is immutable. Contract validation and bounded finalization changes require a new factory deployment before they affect production.
- The Admin Zone uses a frontend constant (`1234`). It is a UI gate, not authentication, and is readable from the browser bundle. It must not be treated as a security boundary.
- Browser-managed bot private keys are stored in plaintext local storage by current product design. A compromised browser profile or injected script can read them. Long-running production bots should use a server-side signer, managed key service, or isolated worker wallet.

### High

- The legacy finalizer path scans every deployed auction and can exceed public RPC capacity as contract history grows. The new contract has bounded factory finalization, but the deployed contract and automation migration still need to be coordinated.
- Default RPC endpoints are shared/public capacity. Failover and cooldown reduce outages but cannot guarantee sustained multi-bot throughput. Use at least one authenticated dedicated Sepolia endpoint for scheduled automation and bot runs.

### Medium

- The largest lazy JavaScript chunk is 432.14 kB gzip. Runtime pages are split, but the Web3/tooling chunk remains a cold-load hotspot.
- The optimized CRA build took 11 minutes on this Windows runner. Application stress bodies completed quickly, so this is primarily build-tool overhead. A future migration to a current bundler would improve developer and CI turnaround.
- Mobile widths intentionally show an unsupported-device screen. There is no horizontal overflow, but this remains a product limitation rather than responsive mobile functionality.
- Dependency audit could not produce a result because the Yarn audit registry returned HTTP 500. This report does not claim the dependency tree is vulnerability-free.

## Release Gate

The current source and build pass the local release matrix. Before production deployment, deploy the updated factory, update the production factory address, configure a dedicated RPC endpoint and Auto Finalizer owner key, then run a small-value Sepolia smoke auction through bid, close, payment, refund, and report export.
