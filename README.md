# Blockchain Data Market Platform

This is a React/Web3 marketplace for data auctions on Sepolia. Sellers open auctions, bidders compete with a contract-managed budget, winners can access the sold data after finalization, and admins can manage budgets, contracts, batch auction creation, and reporting.

This README is written as a handoff guide for the next person maintaining the project. It focuses on how the system actually works, what files matter, and the details that are easy to forget.

## Current Mental Model

- The blockchain contracts are the source of truth for auctions, bids, budgets, and finalization.
- The frontend is a Create React App application that talks directly to contracts through Web3.
- The app supports two primary markets: `real` and `dev`.
- Each market is a different `CampaignFactory` contract address.
- The Real/Dev switcher changes which factory the frontend reads from and writes to.
- Contract switching must stay factory-scoped. Do not let async reads from one factory update UI state after the user has switched to another factory.
- Admin tools are frontend convenience tools, not backend security boundaries.

## Tech Stack

- React with Create React App
- React Router
- Web3.js
- Material UI components/icons in parts of the app
- Solidity contracts compiled with `solc`
- Sepolia testnet
- Optional local indexer and scheduled keeper scripts

## Important Entry Points

| Area | File |
| --- | --- |
| Routes and app shell fallback | `src/App.js` |
| Global layout, toolbar, Real/Dev switcher | `src/components/Toolbar.js` |
| Auction list loading, sorting, search, caching | `src/pages/AuctionsList/AuctionsListPage.js` |
| Create single auction | `src/pages/NewAuction/NewAuctionPage.js` |
| Auction details, bidding, finalize/refund flows | `src/pages/ShowAuction/ShowAuctionPage.js` |
| Admin zone page | `src/pages/ManageBudget/ManageBudgetPage.js` |
| Batch auction helpers | `src/pages/ManageBudget/bulkAuctionUtils.js` |
| Report generation helpers | `src/pages/ManageBudget/reportUtils.js` |
| Contract source | `src/real_ethereum/contracts/Campaign.sol` |
| Contract compile script | `src/real_ethereum/compile.js` |
| Contract deploy script | `src/real_ethereum/deploy.js` |
| Real/Dev market config | `src/real_ethereum/marketConfig.js` |
| Active factory proxy | `src/real_ethereum/factory.js` |
| Read-only RPC provider and batching | `src/real_ethereum/readOnly.js` |
| Budget reads scoped by market | `src/real_ethereum/budget.js` |
| Websocket/event contracts | `src/real_ethereum/socketFactory.js` |
| Auto-finalizer keeper | `scripts/autoFinalizeAuctions.js` |
| Optional auction indexer API | `scripts/auctionIndexer.js` |

## Getting Started Locally

Install dependencies:

```powershell
npm install
```

Start the React app:

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

You need MetaMask installed and connected to Sepolia for wallet actions such as creating auctions, bidding, finalizing, refunds, and budget reset transactions.

## Environment Variables

Local environment belongs in `.env`. It is gitignored. Do not commit private keys.

Create `.env` from this shape:

```text
REACT_APP_REAL_FACTORY_ADDRESS=0x...
REACT_APP_DEV_FACTORY_ADDRESS=0x...
REACT_APP_RPC_URLS=https://your-sepolia-rpc-1,https://your-sepolia-rpc-2
REACT_APP_WS_RPC_URL=wss://your-sepolia-websocket
REACT_APP_AUCTION_API_URL=http://localhost:8787

DEPLOY_MARKET=dev
DEPLOY_PRIVATE_KEY=...
DEPLOY_RPC_URL=https://your-sepolia-rpc
```

Useful variables:

| Variable | Used by | Notes |
| --- | --- | --- |
| `REACT_APP_REAL_FACTORY_ADDRESS` | frontend | Public real market factory address, baked into production builds. |
| `REACT_APP_DEV_FACTORY_ADDRESS` | frontend | Public dev market factory address, baked into production builds. |
| `REACT_APP_TEST_FACTORY_ADDRESS` | frontend | Legacy fallback used by older config paths. Prefer the explicit dev/real keys. |
| `REACT_APP_RPC_URLS` | frontend/scripts | Comma-separated read-only RPC failover list. Use this to avoid public RPC 429s. |
| `REACT_APP_RPC_URL` | frontend/scripts | Single read-only RPC fallback. |
| `REACT_APP_RPC_TIMEOUT_MS` | frontend | Optional timeout for read-only RPC calls. |
| `REACT_APP_WS_RPC_URL` | frontend/indexer | Websocket RPC for contract events. |
| `REACT_APP_AUCTION_API_URL` | frontend | Optional local indexer URL. If absent, the auction list reads directly from chain. |
| `DEPLOY_MARKET` | deploy script | `dev` or `real`. Defaults to `dev`. |
| `DEPLOY_PRIVATE_KEY` | deploy script | Preferred deploy key. Never expose as `REACT_APP_*`. |
| `PRIVATE_KEY` | deploy/keeper scripts | Supported fallback. Keep private. |
| `AUTO_FINALIZE_PRIVATE_KEY` | keeper/deploy fallback | Keeper wallet key. Must have Sepolia ETH for gas. |
| `DEPLOY_RPC_URL` | deploy script | Preferred deploy RPC URL. |
| `RPC_URL` | scripts | Generic RPC fallback for deploy, keeper, and indexer. |
| `INFURA_KEY` | scripts | Builds Infura Sepolia HTTP/WS URLs when direct RPC URLs are not supplied. |
| `FACTORY_ADDRESS` | keeper/indexer scripts | Important for scripts that still default to the legacy `factoryAddress.js`. |

Important: Create React App bakes `REACT_APP_*` values at build time. If a factory address changes, rebuild and redeploy the frontend.

## Available Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the React dev server. |
| `npm run build` | Build the production frontend into `build/`. |
| `npm test` | Start the test runner in watch mode. |
| `npm run auto-finalize` | Run one auto-finalizer cycle. |
| `npm run auto-finalize:watch` | Run the auto-finalizer continuously. |
| `npm run auction-indexer` | Start the optional local auction indexer API. |
| `node src/real_ethereum/compile.js` | Compile Solidity contracts into `src/real_ethereum/build/`. |
| `node src/real_ethereum/deploy.js` | Deploy a new factory contract. |

For CI-style local checks:

```powershell
$env:CI="true"
npm test -- --watchAll=false
npm run build
```

## Smart Contracts

The contracts live in `src/real_ethereum/contracts/Campaign.sol`.

`CampaignFactory`:

- Creates auction contracts.
- Stores deployed campaign addresses.
- Stores user budgets.
- Holds the default budget, currently `2000`.
- Allows only known campaign contracts to change budgets.
- Emits budget and auction creation events.

`Campaign`:

- Represents one auction.
- Stores seller, data description, private data payload, minimum bid, end time, highest bid, highest bidder, participants, and bid history.
- Prevents sellers from bidding on their own auctions.
- Deducts bidder budget when a valid bid is placed.
- Restores the old highest bidder budget when they are outbid.
- Finalizes after the end time and pays the seller.
- Supports refunds for losing bidders.
- Exposes list-focused read helpers such as `getListSummary()`.
- Exposes bid ledger helpers such as `getBidLedger()` and `getBidLedgerAt()`.

The bid ledger records the bidder budget at the exact moment of the bid:

- `value`: amount sent in that transaction.
- `cumulativeBid`: bidder's total bid in the auction after the transaction.
- `budgetBefore`: bidder budget before the contract budget change.
- `budgetAfter`: bidder budget after the contract budget change.
- `previousHighestBidder`: highest bidder before this bid.
- `previousHighestBid`: highest bid before this bid.
- `time`: block timestamp for the bid.

These fields are used by the auction reports. Old auctions deployed from older bytecode may not have every helper method. Report and list code should keep graceful fallbacks.

## Compile And Deploy Contracts

Compile:

```powershell
node src/real_ethereum/compile.js
```

Deploy the dev market:

```powershell
$env:DEPLOY_MARKET="dev"
node src/real_ethereum/deploy.js
```

Deploy the real market:

```powershell
$env:DEPLOY_MARKET="real"
node src/real_ethereum/deploy.js
```

The deploy script requires a deploy key and an RPC URL. Use one of these key sources:

- `DEPLOY_PRIVATE_KEY`
- `PRIVATE_KEY`
- `AUTO_FINALIZE_PRIVATE_KEY`
- `DEPLOY_MNEMONIC`
- `MNEMONIC`

Use one of these RPC sources:

- `DEPLOY_RPC_URL`
- `RPC_URL`
- `INFURA_KEY`

After a successful deploy, `deploy.js` updates `.env`:

- `REACT_APP_DEV_FACTORY_ADDRESS` when `DEPLOY_MARKET=dev`
- `REACT_APP_REAL_FACTORY_ADDRESS` when `DEPLOY_MARKET=real`

Then restart the dev server or rebuild production.

Important: deploying a new factory only affects new auctions created through that factory. Existing auction contracts keep their old bytecode forever.

## Real And Dev Markets

Real/Dev market configuration is centralized in `src/real_ethereum/marketConfig.js`.

The frontend address priority is:

1. Browser localStorage override from the Admin Contract Manager.
2. `REACT_APP_REAL_FACTORY_ADDRESS` or `REACT_APP_DEV_FACTORY_ADDRESS`.
3. Hardcoded fallback addresses in `marketConfig.js`.

LocalStorage keys:

- `data-market:active-factory`
- `data-market:real-factory-address`
- `data-market:dev-factory-address`

The Admin Contract Manager can save addresses in the browser. This is useful for testing, but remember that browser-saved addresses are local to that browser and do not update the deployed site for other users. For production, update env values and rebuild.

## Auction List Reliability Rules

The auction list has had issues with rate limits, stale reads, and mixed Real/Dev state. Preserve these rules when editing it:

- Capture the active factory address at the start of each async load.
- Scope cache entries by factory address.
- Ignore stale responses if the active factory changed while the request was in flight.
- Never let a failed read remove a previously loaded auction from the visible list.
- Prefer newest auctions first, then older auctions.
- Keep placeholders lightweight and animated, but do not make loading rows look like real auction data.
- Avoid aggressive parallel reads against public RPCs. They return 429 quickly.
- Prefer MetaMask/injected provider for user-facing chain context, but do not spam it with hundreds of reads at once.

If the list becomes slow or unstable, first check RPC rate limits, active factory address, and stale request guards.

## Admin Zone

The admin page is at:

```text
/manage-budget
```

Main tools:

- Global budget manager.
- Contract manager for Real/Dev addresses.
- Batch Auction Studio.
- Auction Reports builder.

The admin password is frontend-only and should not be treated as real security. It is useful for demo/project control, not for protecting blockchain actions. Wallet permissions and contract rules are the real enforcement layer.

### Global Budget

The contract default budget is `2000`. The Reset action should reset budgets to `2000`.

Budget transactions still require MetaMask because they modify contract state.

### Batch Auction Studio

The Batch Auction Studio helps prepare and create multiple auctions more quickly. It is designed for opening around 10 experiment auctions without manually filling the same form repeatedly.

Important details:

- Each auction creation is still its own blockchain transaction.
- MetaMask must stay open and connected.
- Failures should be shown per row, not treated as a total batch failure.
- The UI is collapsible by default in the admin page.

### Auction Reports

Auction Reports creates exports for selected auctions and date ranges. It can include:

- README sheet with human explanations.
- Auction summary.
- All bids.
- Timeline.
- Payment review.
- Participant analysis.
- Review flags.
- Leaderboards.
- Raw data.

The user can choose report tabs and diagnostic rules before download. The reports should include auctions with zero bids. Zero-bid auctions are important data, not missing data.

Date selection is expected before loading reports unless the user explicitly chooses to export every auction in the contract.

The README sheet inside generated Excel reports should explain terms such as:

- ISO time.
- Auction end time.
- Bid time.
- Highest bid.
- Number of bidders.
- Budget before bid.
- Budget after bid.
- Review flags.
- Payment/reconciliation status.

Avoid one sheet per individual auction unless someone explicitly reintroduces that feature. It made the workbook noisy.

## Optional Auction Indexer

The frontend can read directly from chain, but `scripts/auctionIndexer.js` provides an optional local API for faster auction list reads.

Run it:

```powershell
npm run auction-indexer
```

Default URL:

```text
http://localhost:8787
```

Health check:

```text
http://localhost:8787/health
```

Auction endpoint:

```text
http://localhost:8787/auctions?limit=20&q=search
```

Set the frontend to use it:

```text
REACT_APP_AUCTION_API_URL=http://localhost:8787
```

Important: the indexer still defaults to the legacy `src/real_ethereum/factoryAddress.js` if `FACTORY_ADDRESS` is not supplied. For Real/Dev support, run separate indexer processes with explicit `FACTORY_ADDRESS` values or update the script to be market-aware.

## Automatic Finalization

Seller payouts do not require the seller to confirm a MetaMask transaction. `Campaign.finalizeAuctionIfNeeded()` is public, so a keeper wallet can pay gas and finalize ended auctions.

Local one-shot run:

```powershell
npm run auto-finalize
```

Local continuous run:

```powershell
npm run auto-finalize:watch
```

The GitHub Actions workflow is:

```text
.github/workflows/auto-finalize-auctions.yml
```

It runs every 5 minutes and can be manually triggered.

Required secret:

- `AUTO_FINALIZE_PRIVATE_KEY`: keeper wallet private key with Sepolia ETH for gas.

Recommended secrets:

- `RPC_URL`
- `INFURA_KEY`
- `FACTORY_ADDRESS`

Important: `scripts/autoFinalizeAuctions.js` still defaults to `src/real_ethereum/factoryAddress.js` when `FACTORY_ADDRESS` is missing. If the active production market is controlled through `REACT_APP_REAL_FACTORY_ADDRESS`, also set `FACTORY_ADDRESS` in GitHub Actions so the keeper finalizes the correct factory.

## Testing And Build Checklist

Before uploading or deploying:

```powershell
$env:CI="true"
npm test -- --watchAll=false
npm run build
```

Manual smoke test:

- Open the app on Sepolia.
- Switch Real to Dev and back without being navigated away.
- Confirm auction list content does not mix between markets.
- Confirm global budget display remains visually stable during market switch.
- Open Admin Zone.
- Expand/collapse Batch Auction Studio and Auction Reports.
- Load report auctions by date and confirm zero-bid auctions appear.
- Create a small dev auction.
- Place a test bid from a different wallet if available.
- Confirm the auction appears in the correct market only.

## Deployment Notes

- `.env` is local and not committed.
- `.env.production` may contain public `REACT_APP_*` values for production builds.
- `REACT_APP_*` values are public in the browser bundle. Never put private keys there.
- Rebuild after changing factory addresses.
- Public Sepolia RPC endpoints often rate-limit with 429 responses. Use dedicated RPC URLs for reliable demos.
- Websocket providers may fail independently from HTTP providers. The app should continue to work with polling/fallback reads.

## Common Failure Modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Dev market does not load on deployed site | Missing baked `REACT_APP_DEV_FACTORY_ADDRESS` | Add/update env and rebuild. |
| Real/Dev switch shows the wrong auctions briefly | Stale async read overwrote current state | Scope read/cache by factory and ignore stale responses. |
| Auction list hides rows after refresh | Failed RPC read treated as missing data | Preserve previous row data and surface a soft loading/error state. |
| Many `429 Too Many Requests` errors | Public RPC overload | Add private/dedicated RPC URLs to `REACT_APP_RPC_URLS` or `RPC_URLS`. |
| MetaMask `execution reverted` while reading old auctions | Calling helpers missing on old bytecode or contract require failed | Keep compatibility fallbacks around old contract methods. |
| Reports miss zero-bid auctions | Report builder filtered on bid count | Treat zero bids as a valid auction state. |
| Keeper finalizes the wrong market | `FACTORY_ADDRESS` missing and legacy fallback used | Set `FACTORY_ADDRESS` explicitly in secrets/env. |
| New contract features do not appear in old auctions | Old auctions are separate deployed contracts | Deploy a new factory and create new auctions. |
| Changed env but website still uses old address | CRA build has old env baked in | Rebuild and redeploy frontend. |
| Browser uses unexpected factory address | LocalStorage override from Contract Manager | Clear or update the saved address in Admin Zone. |

## Development Guidelines

- Keep Real/Dev market state explicit. Pass the factory address through async workflows instead of re-reading global active state halfway through.
- Do not add backend/private-key behavior to frontend files.
- Use contract events and helper reads where possible, but keep old-contract fallbacks.
- Be gentle with RPC calls. Prefer small batches, concurrency limits, retries, and cached data over hundreds of parallel reads.
- Keep UI loading states stable. A refresh should not make the page jump, reset scroll, or navigate the user away.
- Preserve admin tools as collapsible, focused sections. The admin page can get large quickly.
- For reports, keep the workbook understandable: fewer meaningful tabs are better than many auction-specific sheets.
- Treat generated report documentation as part of the product. The next reader may only see the Excel file, not the app.

## Handoff Checklist For A New Developer

1. Install dependencies with `npm install`.
2. Create a local `.env` with Sepolia RPC and both factory addresses.
3. Run `npm start`.
4. Connect MetaMask to Sepolia.
5. Verify Real and Dev market switching.
6. Compile contracts with `node src/real_ethereum/compile.js`.
7. Deploy a dev factory only if contract changes are needed.
8. Update `REACT_APP_DEV_FACTORY_ADDRESS` or `REACT_APP_REAL_FACTORY_ADDRESS`.
9. Restart the dev server after env changes.
10. Run tests and production build before uploading.
11. If keeper/indexer scripts are used, set `FACTORY_ADDRESS` explicitly.

## Current Contract Addresses

Fallback addresses are currently defined in `src/real_ethereum/marketConfig.js`. Treat those as defaults, not as the only source of truth. Production builds should get explicit `REACT_APP_REAL_FACTORY_ADDRESS` and `REACT_APP_DEV_FACTORY_ADDRESS` values from env.

At the time this README was rewritten, `.env.production` included a public dev factory address. Check the actual deployed environment before assuming the live site is using the same value.
