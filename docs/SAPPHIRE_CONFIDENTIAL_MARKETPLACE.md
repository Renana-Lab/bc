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
| `DEPLOY_NETWORK`, `DEPLOY_PRIVATE_KEY`, `FACTORY_SIWE_DOMAIN` (see above), `DEPLOY_MARKET` | `src/real_ethereum/deploy.js` (localnet/testnet only) |

### SIWE domain

The domain is set once, in the `CampaignFactory` constructor, by `src/real_ethereum/deploy.js` from the
`FACTORY_SIWE_DOMAIN` env var (host plus port, no scheme, e.g. `localhost:3000` or `market.example.org`).
It is stored in the contract and cannot be changed; a different host needs a new factory.

- `sapphire-localnet`: defaults to `localhost:3000` when `FACTORY_SIWE_DOMAIN` is unset.
- `sapphire-testnet`: no default. The script refuses to deploy without `FACTORY_SIWE_DOMAIN`, so a
  localhost value cannot be baked into a deployed factory by accident.
- The app reads it with `factory.domain()` and compares it to `window.location.host` before asking
  MetaMask to sign. On a mismatch it shows an error naming both hosts instead of a signature prompt the
  contract would reject. Vite's dev server uses port 3000, so `localhost:3000` matches `npm start`.

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
- The old Sepolia factory (previously the hardcoded fallback) is incompatible and was removed.
- The MetaMask browser flow has not been run by an automated agent (it needs the extension unlocked and
  an account imported). Run the checklist below before relying on it.

## Manual MetaMask checklist (sapphire-localnet only)

Prepare (terminal, repo root):

1. `docker run -d --name sapphire-localnet -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet`
   and wait for "Web3 RPC listening on http://localhost:8545" in `docker logs sapphire-localnet`.
2. In MetaMask import three localnet accounts from the public localnet mnemonic printed in the docker
   logs (`test test ... junk`, indexes 0, 1, 2 = seller, winner, loser). Use a throwaway MetaMask profile;
   never import this phrase into a wallet that holds real funds.
3. Deploy the factory (key from the localnet account 0, set in your shell only):
   `DEPLOY_NETWORK=sapphire-localnet DEPLOY_MARKET=real DEPLOY_PRIVATE_KEY=<account 0 key> node src/real_ethereum/deploy.js`
   This writes `REACT_APP_REAL_FACTORY_ADDRESS` to the git-ignored `.env`.
4. `REACT_APP_NETWORK=sapphire-localnet npm start`, open `http://localhost:3000` (must be exactly
   `localhost:3000`; the factory domain defaults to that).

Steps and expected results:

| # | Action | Expected |
| - | ------ | -------- |
| 1 | Connect MetaMask as the seller. | Connection prompt, then a "Switch network / Allow this site to add a network" prompt for "Oasis Sapphire Localnet" (chain 23293). After approving, MetaMask shows that network. |
| 2 | Create an auction (any description, payload `SECRET-123`, 1 minute, small minimum bid). | One transaction confirmation. In MetaMask's activity the data field is not readable text. Auction appears in the list with its description only. |
| 3 | Switch MetaMask to the loser account and open the auction page. | The payload `SECRET-123` is not shown anywhere on the page. No signature prompt appears. |
| 4 | As loser then winner, place bids (loser first, winner higher), e.g. 50 and 100 wei. | One transaction confirmation per bid. |
| 5 | Wait for the auction to end and finalize (use the auction page / auto-finalize). | Auction shows closed. |
| 6 | As the loser open the closed auction. | Still no payload. If a sign-in prompt appears and you approve it, the page still shows no payload. |
| 7 | As the winner open the closed auction. | Exactly one MetaMask "Sign message" popup: text starts with `localhost:3000 wants you to sign in with your Ethereum account`, shows Chain ID 23293 and an expiry about 1 hour out. After approving, "Data acquired" shows `SECRET-123`. |
| 8 | Navigate to another page and back, or wait for the page to refresh data (still no browser reload). | No new signature popup; payload still shown (token and payload are cached in memory). |
| 9 | Hard-reload the tab (F5) and open the same auction as the winner. | A new SIWE signature popup appears (the in-memory token is gone). Approve it and the payload shows. |
| 10 | Reload again, open the auction and click Reject on the signature popup. | The payload is not shown and the popup does not reappear on every refresh for about a minute. |
| 11 | Open the app on `http://127.0.0.1:3000` instead of `localhost:3000` and open the closed auction as the winner. | No signature popup; an error says the factory only accepts sign-in on `localhost:3000`. |

Cleanup: `docker rm -f sapphire-localnet`.
