# Confidential marketplace on Oasis Sapphire

`dataForSell` (the auction payload) is stored and read only on Oasis Sapphire, a confidential EVM.
MetaMask stays the wallet. No backend, embedded wallet, paymaster or relayer is involved.

## What changed

- `Campaign.dataForSell` is `private`. No public getter; not returned by `getSummary()`, not in events.
  `getSummary()` now returns 9 values (the payload slot was removed, so the later indexes shifted by one:
  description 5, highestBidder 6, addresses 7, endTime 8).
- Winner-only reads: `getData()` (gated on `closed && msg.sender == highestBidder`) and
  `getDataWithToken(bytes)`. Both also require a non-zero `highestBidder`, because on Sapphire an
  unauthenticated `eth_call` has `msg.sender == address(0)`.
- `CampaignFactory` inherits Sapphire's `SiweAuth` (`login(siweMsg, sig)` returns an encrypted bearer
  token). Its constructor takes the SIWE domain (the app host, e.g. `localhost:3000`).
- Frontend: `window.ethereum` is wrapped with `@oasisprotocol/sapphire-paratime`
  (`src/real_ethereum/sapphireProvider.js`) in the wallet transport and the injected read provider, so
  transactions (including `createCampaign`) and `eth_call`/`eth_estimateGas` are encrypted.
- Sapphire networks (`src/real_ethereum/sapphireNetworks.js`): Testnet 23295 / `0x5aff`, Localnet
  23293 / `0x5afd`. Mainnet is not configured. MetaMask is prompted to switch (or add) the configured
  network on connect and before every write.
- SIWE session (`confidentialData.js`, `siwe.mjs`): the winner signs once per 60 minutes; the token is
  kept in memory only.

## Why SIWE and not signed view calls

`@oasisprotocol/sapphire-paratime` 2.3 and `sapphire-ethers-v6` 6.0 encrypt `eth_call` but do not sign
it, so an `eth_call` from a browser wallet still has `msg.sender == address(0)`. Authenticating reads
therefore uses the SIWE token flow (the official `sapphire-contracts` mechanism). It needs one MetaMask
signature per session instead of one per read.

## Configuration

| Variable | Meaning |
| --- | --- |
| `REACT_APP_NETWORK` | `sapphire-testnet` (default) or `sapphire-localnet` |
| `REACT_APP_FACTORY_ADDRESS` | CampaignFactory on that network (no factory is committed) |
| `REACT_APP_RPC_URLS` / `REACT_APP_RPC_URL` | optional RPC override |
| `DEPLOY_NETWORK`, `DEPLOY_PRIVATE_KEY`, `FACTORY_SIWE_DOMAIN`, `DEPLOY_MARKET` | `src/real_ethereum/deploy.js` (localnet/testnet only) |

The SIWE domain given to the factory must match the host users open the app on. MetaMask warns if the
signing domain differs from the page origin.

## Compile, run localnet, test

```bash
npm run sapphire:compile            # writes src/real_ethereum/build/*.json
docker run -d --name sapphire-localnet -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet
# wait for "Web3 RPC listening on http://localhost:8545" in `docker logs sapphire-localnet`
REQUIRE_LOCALNET=1 npm run sapphire:test
```

The localnet funds five accounts from the public mnemonic `test test test test test test test test test
test test junk` (localnet only). The test takes about 75 s because the shortest auction is 1 minute.
Without the localnet the test is skipped (set `REQUIRE_LOCALNET=1` to fail instead).

Covered: payload not in the creation tx input; not reachable via `getSummary`, the ABI/selector, spoofed
`from` `eth_call` (plain and encrypted), logs or storage; not readable before finalization; after close
only the winner (SIWE token) reads it, while loser, seller, outsider, empty and garbage tokens revert.

## Compiler notes

- Sapphire does not execute `MCOPY`, so contracts compile with `evmVersion: shanghai` and
  `@openzeppelin/contracts` is resolved from `oz-sapphire-compat` (OZ 5.0.2) at compile time only.
- `CampaignFactory` runtime code is about 21.4 KB (limit 24 KB), so it has little headroom.

## Known limits and follow-ups

- The seller can still upload worthless data (out of scope).
- Reports and CSV exports show `[confidential]` for "Data For Sale".
- The `stress:contract` / `stress:automation` scripts (ganache) and `src/tests/testFinalize.js` cannot run
  the new contracts (no Sapphire precompiles on ganache) and still call `createCampaign` in cleartext.
  `scripts/experiment/*` is pinned to Sepolia and sends raw signed transactions without the wrapper.
  Port these to the localnet before using them with this contract.
- `yarn.lock` was not regenerated (yarn is not installed here); run `yarn install` to refresh it.
- The old Sepolia factory (previously the hardcoded fallback) is incompatible and was removed.
- Not verified in a real browser with MetaMask (no browser wallet in this environment). The wrapper is
  exercised through ethers on localnet and the production bundle builds.
