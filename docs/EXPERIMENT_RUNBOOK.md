# Human-vs-Bot Experiment Runbook

This runbook operates the 20-minute, 10-auction production Sepolia experiment. The browser never receives experiment private keys. Preparation and execution run locally from the repository; the Admin Zone imports only public evidence for reporting.

## Safety Model

- The source wallet table is read only.
- Password and seed-phrase columns are discarded by the parser.
- The prepared keys file is written under `experiment-data/private`, which is gitignored.
- Production execution requires the exact experiment ID in `--confirm`.
- A Ctrl+C stop cancels queued writes. Transactions already submitted remain valid and are recorded.
- Failed-run logs and public evidence are preserved.

## 1. Prepare And Preflight

From PowerShell in the repository root:

```powershell
npm run experiment:prepare -- --wallets "C:\path\to\wallets.txt"
```

Optional reproducible ID and seed:

```powershell
npm run experiment:prepare -- --wallets "C:\path\to\wallets.txt" --id EXP-SESSION-01 --seed fixed-seed-01
```

Preparation checks Sepolia chain ID, private-key/address matching, live ETH balances, pending nonces, contract budgets, role uniqueness, and the production factory address. It requires ten wallets with at least `0.02 ETH` and thirty separate bidder wallets with at least `0.005 ETH`; every selected participant must have a contract budget of exactly `2000`.

It produces:

- `experiment-data/private/<experimentId>.json`: local keys and roles.
- `experiment-data/public/<experimentId>.manifest.json`: addresses, roles, seed, and protocol only.

Do not continue if preparation reports fewer than 40 eligible wallets.

## 2. Rehearse

Run the same protocol against the development branch/factory first. Use separately funded development wallets. Confirm auction creation, stop behavior, all four human archetypes, concurrent bot assignment, report import, and finalization before the production session.

## 3. Execute Production Session

```powershell
npm run experiment:run -- --config ".\experiment-data\private\EXP-SESSION-01.json" --confirm EXP-SESSION-01
```

The runner:

1. Rechecks the chain, role isolation, and all 30 actor budgets.
2. Creates ten 25-minute auctions through ten distinct sellers with at most three concurrent writes.
3. Verifies all ten auctions and at least 20 minutes remaining.
4. Starts twenty seeded human actors and ten coordinated standard bots together.
5. Uses one shared auction snapshot, unique bot assignments, and per-wallet nonce queues.
6. Stops queued actor work at exactly 20 minutes.
7. Waits for auction deadlines, finalizes all ten auctions, and writes acceptance evidence.

Runtime evidence is stored at:

- `experiment-data/runs/<experimentId>.jsonl`
- `experiment-data/runs/<experimentId>.state.json`

## 4. Generate Reports

In Admin Zone, expand **Experiment Evidence**:

1. Import `experiment-data/public/<experimentId>.manifest.json`.
2. Import `experiment-data/runs/<experimentId>.jsonl`.
3. Open Auction Reports and enable **Experiment Evidence**.
4. Generate Excel, HTML, JSON, and required CSV files.

All Bids includes cohort, archetype, actor ID, bid budget snapshots, transaction hash, and Etherscan URL when the contract event is available. Experiment sheets include the protocol, public roles, decisions, active-list changes, heartbeats, transactions, failures, and acceptance evidence.

## 5. Remove Keys

After the final exports have been verified:

```powershell
npm run experiment:cleanup -- --id EXP-SESSION-01 --confirm EXP-SESSION-01
```

This removes only the private prepared config. Public manifests, reports, and failed-run evidence remain available.

## Invalid Run Conditions

Preserve the evidence and schedule a rerun if the chain is wrong, fewer than ten experiment auctions are active at start, any auction has under 20 minutes remaining at start, the active list is stale for over 60 seconds, fewer than 90% of actors are healthy for two consecutive minutes, or report evidence is incomplete.
