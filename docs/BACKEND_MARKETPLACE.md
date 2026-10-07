# Account-Based Marketplace Variant

This is a standalone, account-based marketplace. It uses server-managed users,
credits, auctions, settlements, reports, and automation. Existing live data from
other applications is not imported automatically.

## Local Run

Requires Node 22.13 or newer with `node:sqlite` (Node 22 prints an experimental
SQLite warning). Use the current Node 22/24 LTS release for deployment.

```powershell
npm run market:create-admin -- --identifier research-admin
npm run market:dev
```

The first command creates the administrator's identifier account. Sign-in and
registration use a case-insensitive identifier, without an email or password.
Participants must register their Prolific ID or identifier before signing in.
`POST /login` never creates an account; `POST /register` rejects existing identifiers
and signs in only after creating the account successfully. Existing accounts remain registered.
Identifiers allow letters, numbers, dots, underscores, hyphens, @ and + (200 characters maximum).
Existing email-shaped identifiers continue to work with the same account and balance.
The database's unique `email` column and legacy API input remain compatibility aliases;
`identifier` is the primary API/UI field. No database reset or account migration is needed.
It refuses to bootstrap a second administrator; create additional administrators
through Admin Zone. For local development only, `Quick dev sign-in` appears on the
login screen and creates/reuses `dev-admin@market.invalid`. It is loopback-only,
disabled unless `MARKET_DEV_LOGIN=1` is set by `npm run market:dev`, and is disabled
when `NODE_ENV=production`. It is never a production authentication mechanism.
Quick dev sign-in opens the Admin Zone without an additional prompt. Every regular
administrator session must unlock the Admin Zone with `MARKET_ADMIN_PASSWORD`.
The lock is enforced by the server on every `/api/market/admin/*` request, not only
by the page. Local `npm run market:dev` defaults this password to `local-admin`;
set a different value in the environment to override it.

Open http://localhost:3010 using `localhost`, not `127.0.0.1`: the CSRF allowlist
intentionally matches the configured browser origin exactly. API port: 3011.
Existing ports are not killed or reused; close a prior run before restarting.

Database, sessions, passwords, and backups live in gitignored `market-data/`.
The current identifier-only flow does not prove identity; anyone who knows an
identifier can sign in as that account. Use only in a controlled experiment until
additional authentication is configured for public hosting. Session cookies are HttpOnly and
SameSite=Strict. Sessions expire after eight hours and are revoked on account
disable. Password columns are retained only as an internal compatibility boundary
for older local databases and are not requested by the UI.
All data endpoints require a server-verified session. All admin endpoints require
a server-verified admin role. There is no frontend admin passcode.

## Workflows

- Controlled account creation: participant, administrator, and bot roles.
- Identifier sign-in and registration; password endpoints are retired.
- Auction-list database controls (database icon per row) for server-authorized
  admins, including the local dev account: inspect auction records, bids, ledger
  and audit history; edit open, unbid records; close bidding or finalize payment.
  Edits use optimistic revision checks and create audit/list-history events.
  Existing bids and payments are immutable; no raw SQL or destructive table reset
  is exposed. Non-admin requests are rejected even when called directly.
- Auctions: minimum bid, confidential payload, 1-30 minute duration, countdown,
  cumulative bids, bid history, winner-only payload access after settlement.
- Sellers can edit their own open, unbid auctions from the list or detail page.
  Ownership and zero-bid status are rechecked inside the save transaction; a
  concurrent first bid invalidates the edit. Closed/finalized auctions are locked.
- Budget: default 2,000 integer credits, per-user allocation and atomic global
  reset. Budget settings include existing winning reservations; resetting cannot
  manufacture extra credits when an old winner is later outbid.
- Automatic and manual finalization. Seller credits are transferred exactly once.
- Bot Command Center: persistent server-hosted bots, independent intervals,
  1-5 bids per cycle, maximum bid, enable/start/stop, manual rounds, observatory.
  One active-only snapshot is shared by due bots, with rotating unique auction
  assignment. All execution stays inside the marketplace service.
- Batch Auction Studio: atomic JSON batches of up to 50 auctions.
- Dynamic active list, admin early close, observed list history at a timestamp.
- Admin-controlled post-submission editing. When enabled, sellers may edit only
  open auctions with no bids; administrators retain the same audited database
  controls when seller editing is disabled.
- Live counts: human/admin accounts with a heartbeat in the last 45 seconds,
  running bots with recent scheduler activity, and active auctions. Multiple
  tabs for one account count once. Presence samples are persisted every 15 seconds.
- JSON evidence, bid CSV, printable HTML, multi-sheet Excel-compatible XML
  workbook (`.xls`, matching the existing application's export approach).
  Evidence includes bid budgets, credit ledger, events, list transitions, bot
  decisions, participation, seller payments, review flags, and presence samples.

Credits have no cash value. Bidding reserves the full current
winning bid; outbidding immediately returns the previous winner's reservation.
Finalization consumes the winner's reservation and credits the seller. The ledger
records every change in available credit.

Market settings, participant management, automation, evidence, and diagnostics
are controlled directly from the Admin Zone. Legacy experiment tooling requires
a separate adapter before it can be used with these auctions.

## Hosting

```powershell
npm run market:build
$env:MARKET_ORIGIN="https://your-market-domain.example"
$env:MARKET_HOST="0.0.0.0"
$env:MARKET_PORT="3011"
$env:MARKET_STATIC_DIR="build-backend"
$env:MARKET_DATA_DIR="C:\persistent-data\market"
$env:MARKET_ADMIN_PASSWORD="use-a-long-unique-password"
npm run market:server
```

Host one persistent Node process with a persistent local disk and an HTTPS reverse
proxy. It serves the UI and API from the same origin. Set `MARKET_ORIGIN` to that
exact HTTPS origin, without a trailing slash. HTTPS enables Secure cookies.
Do not expose the database directory through the web server. Restrict filesystem
access to the service account. Do not place SQLite on a network share.

Amplify's static-only hosting cannot execute this backend. Use a Node/container/VM
service for this variant; no deployment has been performed by these changes.
Run a **single service replica**. For horizontal scaling, move the transactional
store to PostgreSQL and implement scheduler leadership before adding replicas.
Do not treat this local implementation as a completed production security audit.

`npm run market:backup` creates a consistent SQLite backup including committed
WAL data. Encrypt/copy backups off-host under your retention policy. Test restores
before a real experiment: stop the service, restore the database into a new empty
data directory, point `MARKET_DATA_DIR` there, and restart. Never copy only the main
database file from a live WAL database as a backup.

## Verification

```powershell
npm run market:test
npm run market:build
# With Playwright installed in the environment:
node scripts/market/browserTest.js
node scripts/market/browserTest.js webkit
```

The suite uses an isolated database and does not touch live participant data.
It covers role enforcement, CSRF, concurrent bidding, idempotency, exact closing
boundaries, reservation accounting, atomic batches, session revocation, restart
recovery, immutable ledger, and 100 bots/1,000 historical/50 active auctions.
Browser tests cover login, direct protected URLs, admin controls, bot execution,
auction creation, bid placement, finalization, winner data access, responsive
overflow, and local-only network behavior.
