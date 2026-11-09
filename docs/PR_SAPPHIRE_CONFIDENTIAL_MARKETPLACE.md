# PR title

Store auction payloads confidentially on Oasis Sapphire

# PR description

## Problem
On Sepolia `dataForSell` is a public string: `getSummary()` returns it, `getData()` can be bypassed by
spoofing `from` on `eth_call`, and the plaintext is in the factory creation transaction input.

## Changes
- `dataForSell` is `private`, removed from `getSummary()` (now 9 values; indexes after the description
  shifted by one, all callers updated), never emitted.
- Winner-only reads via `getData()` (msg.sender) and `getDataWithToken()` (SIWE token from the factory,
  which now inherits Sapphire `SiweAuth`). A zero `highestBidder` can no longer match an unauthenticated
  caller.
- MetaMask provider wrapped with `@oasisprotocol/sapphire-paratime` so transactions and view calls are
  encrypted; deploy script uses `sapphire-ethers-v6`.
- Sapphire Testnet (23295) and Localnet (23293) network config with switch/add-network prompts;
  `REACT_APP_NETWORK` selects the network, `REACT_APP_FACTORY_ADDRESS` the factory (no factory committed).
- One-signature SIWE session for confidential reads (60 min, in-memory token).
- Compiler: shanghai EVM and OpenZeppelin 5.0.2 for compilation, because Sapphire lacks `MCOPY`.

## Testing
- `REQUIRE_LOCALNET=1 npm run sapphire:test` against `ghcr.io/oasisprotocol/sapphire-localnet`: 6/6 pass
  (payload absent from creation tx input, getSummary, selector, spoofed-from calls, logs, storage; only
  the winner reads it after close).
- `react-scripts test`: 16 suites / 120 tests pass; `vite build` succeeds.
- **Not done: the manual MetaMask browser checklist** (docs/SAPPHIRE_CONFIDENTIAL_MARKETPLACE.md) is still pending; no browser check is reported as passed.
- Localnet suite last ran before the final review-fix commit; no public network was contacted or deployed to.

## Follow-ups
- Signed view calls (not supported by the current JS wrappers) could replace SIWE later.
- Port stress/experiment scripts and `testFinalize.js` (they default to Sepolia and would send plaintext payloads).
- Deploy to Sapphire Testnet and set `REACT_APP_FACTORY_ADDRESS` / `FACTORY_SIWE_DOMAIN`.

## Remaining gaps / merge blockers
- Manual MetaMask checklist pending.
- Scheduled workflows (auto-finalize, botnet-cycle) need `FACTORY_ADDRESS` and a Sapphire RPC secret before master uses this; they still default to Sepolia.
- Amplify: production needs `REACT_APP_FACTORY_ADDRESS` and `REACT_APP_NETWORK`. An Amplify webhook fires on pushes; whether it builds this branch was not verified.
- SIWE domain is fixed per factory; tokens cannot be revoked before expiry.
- Cosmetic Sepolia Etherscan links/README mentions remain.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
