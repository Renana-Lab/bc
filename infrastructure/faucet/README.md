# Protected faucet

A small AWS stack that gives each anonymous participant **a fixed amount of TEST tokens exactly once**.
Modeled on `infrastructure/live-presence`. The repo has no `infrastructure/protected` folder, so that stack
was used as the template (Lambda Function URL + DynamoDB + a `scripts/*deploy*.js` CloudFormation script).

```
participant link  https://site/?pid=<code>        (the lab hands out codes; no email/phone/name)
browser  --POST {pid, address}-->  Lambda Function URL  (/claim)
                                    1. rate limit (hashed caller, global)      <- before the pid lookup
                                    2. validate pid/address format
                                    3. DynamoDB conditional update: unclaimed -> pending (lease)  <- exactly-once gate
                                    4. sign a fixed-amount transfer, store the signed tx, broadcast, wait
                                    5. DynamoDB: pending -> paid (txHash)
                                    key: AWS Secrets Manager only
monitor Lambda (every 5 min) -> CloudWatch metric BcFaucet/FaucetBalance -> alarm -> SNS email
```

## Guarantees and how they are enforced

| Requirement | Mechanism |
|---|---|
| Only allowlisted pids | The table holds `pid#<sha256(pid)>` items created by `scripts/faucet/generatePids.js`. Unknown codes get a generic 403. Raw codes are never stored or logged. |
| One payment per pid, also in parallel | A conditional `UpdateItem` (`status = unclaimed`, or an expired lease) lets exactly one request win. The signed transaction is stored before it is broadcast, so a crash/retry re-broadcasts the same transaction instead of signing a second one. The Lambda also has reserved concurrency 1 (single signer, sequential nonces). Same pid + same address retried after success returns the original `txHash`; another address gets 403. |
| Fixed, configurable amount | `FAUCET_AMOUNT_WEI` (deploy flag `--amount-wei`, default 1.5 TEST). |
| Key only in Secrets Manager | `scripts/faucet/createFaucetSecret.js` generates the key and stores it directly; it is never printed, written to disk, or put in `.env`. The Lambda role may read only that one secret. The monitor Lambda gets the public address only. |
| Rate limit | Per caller and global counters per time window (DynamoDB atomic counters) in a **separate rate table**. The caller key is `HMAC(secret salt, IP + window)`, so it is not reversible to an IP, not linkable across windows, and never joined with participant codes (the code table holds no IP; the rate table holds no code). TTL = window end + 60 s, no backups. 429 + `Retry-After`. Evaluated before the pid lookup so code guessing is throttled. See `docs/TEST_ENVIRONMENT.md`. |
| Logs never expose the key | Only event names, an 8-char digest prefix and scrubbed error text (hex strings removed) are logged. The key-read error is replaced by a fixed message. Unit test asserts no key, raw tx, pid, address or IP appears in logs. |
| Low-balance alert | Monitor Lambda publishes the balance every 5 minutes; a CloudWatch alarm below `--low-balance` TEST (default 5) **or when the metric goes missing** notifies the SNS topic (email subscription via `--alert-email`; you must confirm the subscription email). |
| Public networks | `CHAIN_ID` must be 23295 (Sapphire Testnet) or 23293 (localnet). Mainnet 23294 is refused. |

Known limits: the Function URL is public (protection is the allowlist, rate limit and single-use codes; add WAF/CloudFront if
you expect abuse). The lab can link a pid to the address it funded (pseudonymous towards the lab). Reserved concurrency 1
means simultaneous requests are NOT queued: Lambda throttles them (429, non-JSON body) while one claim is confirming (up to 20 s). The app retries on 429/202/409/5xx with backoff. It needs an account concurrency quota above 10 (`--reserved-concurrency 0` omits it, at the cost of possible nonce collisions across containers).
The rate limiter counts every request, so a few abusive IPs can exhaust the global limit for everyone (raise `GLOBAL_RATE_LIMIT_PER_WINDOW` or add WAF). A claim for a code that is mid-payment answers 409/202/200, so code validity can be inferred only by someone who already holds that code and address.
A reverted transfer (for example a contract address that rejects plain transfers) releases the code so it can be used again with a normal address; each failed attempt costs the faucet gas, bounded by the rate limits.

### Lab sessions: raise the rate limits

The limits count requests per 10-minute window (`RATE_WINDOW_SECONDS`): `RATE_LIMIT_PER_WINDOW` per caller (default 20, deploy flag
`--rate-limit`) and `GLOBAL_RATE_LIMIT_PER_WINDOW` for everyone together (default 600, deploy flag `--global-rate-limit`). In a lab, a whole
room usually shares ONE public IP (the lab's NAT) and every participant's page makes a status read plus a claim, often at the same minute, so the
per-caller limit trips first and the browser sees `429 rate_limited`. The app retries a rate-limited or failed auto-claim once after 5-15 s, never
more, so for a lab session raise both before it starts, for example `--rate-limit 300 --global-rate-limit 3000` for about 100 participants on one
network, and lower them again afterwards (or edit the two Lambda environment variables directly). The admin password limits are separate and unchanged.

## Prolific mode, payout cap and the open/closed switch

By default (`FAUCET_PID_MODE=allowlist`) nothing above changes. Set `--pid-mode prolific` to use one shared link for the whole
study: the Prolific participant id (24 hex characters) is the pid, no per-person links are generated, and wallet keys are still
created only in the participant's browser. In every mode the faucet is **closed by default** until an admin opens it.

Set `--pid-mode open` when the participant id does not come from Prolific or a pre-generated list (for example a survey tool's own
response id): any pid of 1-128 characters after trimming surrounding whitespace, printable ASCII only (`!` to `~`, no spaces or
control characters inside), is accepted and used **case-sensitively** as the payout key (`Abc` and `abc` are two different ids).
Each distinct pid is paid once (`already_paid` for the same wallet, `not_eligible` for another wallet).

> **Open mode does not verify identity.** Anyone who can reach the faucet can invent pids, and each new pid takes a payout slot.
> The only limits are `FAUCET_MAX_PAYOUTS` (required), the per-caller and global rate limits, and the admin open/closed switch
> (keep the faucet closed except while participants are being onboarded, and set the cap to the number of participants plus rehearsals).
> The optional study / experiment checks below still apply when configured, but they are shared strings, not credentials.

### Environment variables (all set by `template.js` / `deployFaucet.js`)

| Variable | Deploy flag | Meaning |
|---|---|---|
| `FAUCET_PID_MODE` | `--pid-mode allowlist|prolific|open` | Default `allowlist`. In `prolific` mode only `/^[a-fA-F0-9]{24}$/` is accepted (case-folded before hashing); the first claim of a new id inserts its sha256 and then proceeds. In `open` mode any trimmed printable-ASCII pid of 1-128 characters (`/^[!-~]{1,128}$/`) is accepted and hashed exactly as sent (no case folding); same first-claim insert. Same exactly-once, lease/retry and `already_paid` rules in all modes. |
| `FAUCET_MAX_PAYOUTS` | `--max-payouts N` | **Required** in prolific and open mode (positive integer; startup fails otherwise). An atomic counter in the codes table; a new successful payment takes a slot, a released reservation (reverted transfer, empty faucet) gives it back. At the cap, `/claim` answers `403 budget_exhausted`; ids that were already paid still get `already_paid`. Independent of the 10-minute rate limit. |
| `FAUCET_REQUIRED_STUDY_ID` | `--required-study-id` | Optional (prolific and open mode). If set, `body.studyId` must match (timing-safe), else `403 not_eligible` before anything is reserved. |
| `FAUCET_EXPERIMENT_CODE` | env var `FAUCET_EXPERIMENT_CODE` when running `deployFaucet.js` | Optional static shared string; `body.experimentCode` must match (timing-safe). It is a **shared, non-secret string** (it appears in the participants' links as `?exp=`), so it only keeps out people who know the faucet URL but not the link; it is not a credential. Allowed characters: `[A-Za-z0-9_.~-]`, 1-64. `deployFaucet.js` reads it from the environment and passes it as a CloudFormation `NoEcho` parameter, which does appear in the `aws cloudformation deploy` argument list on the machine that deploys, so do not use anything sensitive. It is never logged by the Lambda. Re-set it on every deploy, otherwise it is cleared. |
| `FAUCET_ADMIN_SECRET_ID` | `--admin-secret-arn` | Secrets Manager secret holding the admin password **hash** (scrypt + salt). Required to deploy; the Lambda role may read it. |
| `FACTORY_ADDRESS` | `--factory-address 0x...` | CampaignFactory address used for admin **wallet auth** (`isAdmin(address)` eth_call). Empty = wallet auth disabled, password only. Also set as the `FactoryAddress` template parameter. |
| `ALLOWED_ORIGINS` | `--origins` | The same list as the CORS origins; wallet proofs must be signed for one of these `https://` origins. |
| `FAUCET_AMOUNT_WEI` | `--amount-wei` | Default is now `1500000000000000000` (1.5 TEST). |

Endpoints (Function URL; the auto-return endpoints are listed under "Auto-return of leftover TEST"): `POST /claim`, `GET /status` (public, returns only `{ open, updatedAt, pidMode }`; the browser uses `pidMode` to decide whether non-hex ids may be sent), `POST /admin/state`, `GET /admin/status` and `POST /admin/max-payouts` (both admin-password protected, see "Payout limit").
The open/closed state is a DynamoDB item (`config#faucet`); a missing or unreadable item means **closed**. `/claim` answers
`403 faucet_closed` for **new** reservations only; a pid that is already paid (same address) still gets `already_paid`, and an
in-flight payment whose transaction was already signed can still finish while closed. Nothing new is written and no payout slot is taken.

### Prolific + QuestionPro setup (no real values shown)

1. Prolific study URL (the study link, pointing at QuestionPro):
   `https://<questionpro-survey-url>?custom1={{%PROLIFIC_PID%}}&custom2={{%STUDY_ID%}}`
2. In QuestionPro, redirect at the end of the survey (or at the point where participants should get the marketplace) to:
   `https://<app>/?pid=${custom1}&study=${custom2}`
   (add `&exp=<experiment-code>` if you use `FAUCET_EXPERIMENT_CODE`). The app also understands `PROLIFIC_PID` and `STUDY_ID`.
3. The app keeps the values in `sessionStorage` for the tab and removes `pid`, `PROLIFIC_PID`, `study`, `STUDY_ID` and `exp`
   from the address bar. It sends `{ pid, address, studyId?, experimentCode? }` to `/claim`.
4. Deploy with `--pid-mode prolific --max-payouts <participants> --required-study-id <the Prolific study id>`.

### Setting the admin password

The password is never stored, only a salted scrypt hash.

1. `node scripts/faucet/setAdminPassword.js` prompts twice (hidden input, interactive terminal only) and prints one line of JSON
   (hash + salt, not the password). Nothing is written to a file and no AWS call is made.
2. Store that JSON yourself. In PowerShell, inline JSON loses its quotes, so go through a temporary file (later password
   changes use `put-secret-value` with the same `--secret-string file://...`):
   ```powershell
   $f = Join-Path $env:TEMP 'admin-hash.json'
   node scripts/faucet/setAdminPassword.js | Out-File -Encoding ascii -NoNewline $f
   aws secretsmanager create-secret --name test-bc-faucet/admin --secret-string "file://$($f -replace '\\','/')" --region us-east-1
   Remove-Item $f
   ```
   The Lambda re-reads the secret at most every 60 seconds, so a changed password takes effect within a minute. Do not commit the output.
3. Pass the secret ARN to `deployFaucet.js --admin-secret-arn`.

### Opening and closing the faucet (admins, no AWS access needed)

Open `https://<app>/admin/faucet` (not linked from any page; `REACT_APP_FAUCET_URL` must be set in that build). It shows the
current state from `/status`; type the admin password and press **Open faucet** before the experiment and **Close faucet**
afterwards. The password is kept only in component state for that request (never in localStorage/sessionStorage or the URL).
Server side: `POST /admin/state { open, password }` compares in constant time, counts only **failed** verifications: 5 per caller
per 10 minutes (then 429; IPv6 callers are keyed on their /64) plus a global failure budget of 300, so guessing from many addresses
cannot block the admin's correct password until that budget is gone (it resets with the 10-minute window). It answers `401` with no detail on a wrong password, and never logs the password or body.
Participants see "Test funds are not available right now." while the faucet is closed.

### Admin authentication: wallet first, password as break-glass

Every `/admin/*` route (`state`, `status`, `max-payouts`, `sweeps`, `sweep-settings`, `messages` GET and POST) accepts either credential:

* **Admin wallet (preferred).** Header `x-admin-proof: base64url(JSON { address, message, signature })`, the same proof the Admin Zone gate stores after the admin signs in
  (EIP-4361 text, `personal_sign`, valid 60 minutes). `adminWalletAuth.js` checks, in order: size <= 4 KB and shape; line 1 is `<host> wants you to sign in with your Ethereum account:` with
  `https://<host>` in `ALLOWED_ORIGINS`; `URI` equals that origin; the address line; the exact Admin Zone statement; `Chain ID` equals `CHAIN_ID`; `Issued At` not in the future (60 s skew) and not older than 61 minutes;
  `Expiration Time` in the future and at most 61 minutes after `Issued At`; the signature recovers the address; and finally **the address is an on-chain admin**
  (`isAdmin(address)` on `FACTORY_ADDRESS`, one `eth_call` through `RPC_URL`; cached 60 s when true, 10 s when false, so a removed admin loses access within a minute).
  Bad proof or not an admin: `401`. RPC unreachable: `503` (never fails open; not counted as a failed attempt).
* **Password (fallback).** Unchanged: `x-admin-password` header or `password` in the body, scrypt hash in Secrets Manager. Used when no `x-admin-proof` is sent, or when `FACTORY_ADDRESS` is empty (wallet auth disabled).
* Proof failures count in the same `admf:` failure limit as wrong passwords (5 per caller, then 429). Logs: `admin_auth { method: "wallet"|"password", address? }`; `admin_state_changed` and `admin_max_payouts_changed` include `admin` (the wallet address) for wallet auth.
  The proof, signature and password are never logged.
* CORS `AllowHeaders` include `x-admin-proof`. Deploying this needs the new option `--factory-address` (template change: new `FACTORY_ADDRESS` / `ALLOWED_ORIGINS` env vars and CORS header).

### Payout limit (admins)

`FAUCET_MAX_PAYOUTS` is only the **deploy-time** value. Admins can raise (or lower, never below what was used) the limit at runtime without
redeploying: the value is stored in the codes table (`config#maxPayouts`) and takes precedence; if the item is missing the deploy-time
value applies. If the table cannot be read, the container keeps using the last cap it saw (the faucet runs with reserved concurrency 1),
so a short DynamoDB hiccup does not change the cap. Only a cold start **during** an outage falls back to the deploy-time value, which is
higher than the stored one if the admin had lowered the limit. Lowering is atomic against the counter: the cap is written, the counter is
re-read, and the write is rolled back (`400 below_used`) if payouts already exceed it. Only prolific and open mode have a cap; allowlist mode reports `maxPayouts: null`
and refuses changes (`400 not_applicable`).

* `GET /admin/status` with the password in the **`x-admin-password` header** (never the URL) returns
  `{ payoutsUsed, maxPayouts, faucetAddress, payoutAmount (wei string), open }`.
* `POST /admin/max-payouts { value, password }`: `value` must be an integer, `>= payoutsUsed` (`400 below_used`) and `<= 1000`
  (`400 bad_request`); the change is written to the existing JSON log as `admin_max_payouts_changed { from, to, payoutsUsed }` (never the password).
* Both use the same password check and the same failed-attempt rate limit as `/admin/state` (`401` without detail, `429`).
* The browser CORS `AllowHeaders` now include `x-admin-password` (template change: redeploy the stack once to get the status read).
  The IAM policy already allows `GetItem`/`UpdateItem` on the codes table, so nothing else changes.
* UI: the "Faucet funds" card on `/admin/faucet` (password) and in the Admin Zone (admin wallet) shows `X of Y payouts used, Z left`,
  "+10 / +50 / custom" with a confirmation, the faucet wallet's live balance (needs `REACT_APP_FAUCET_ADDRESS` or the status call),
  a warning below 5 TEST or when `left < 5` or `balance < left * payout amount`, and (Admin Zone only) a confirmed "Top up faucet" transfer.

### Upgrading an existing allowlist deployment

* The faucet is **closed after the deploy** (no state item exists yet). Open it at `/admin/faucet` before participants arrive.
* `--admin-secret-arn` is now required (create the admin secret first, see above).
* The payout counter (`FAUCET_MAX_PAYOUTS`, prolific and open mode) is cumulative and cannot be reset: set it to the number of participants
  **plus** the rehearsal/test claims you expect, because those count too.

### Auto-return of leftover TEST (sweep)

Participants' leftover native TEST returns to the lab (faucet) wallet automatically once they have been inactive, with no button and no
reliance on tab-close events. Nothing here gives the faucet access to a participant key.

* **Browser** (invisible local wallet only; never MetaMask mode, the admin override, the admin key slot or an admin address): after every event
  that can change the balance (bid, create, finalize, withdraw, refund, seller payment, faucet claim or admin top-up seen as a balance change, page
  load; debounced ~5 s) it re-reads balance, pending nonce and gas price and **signs, without broadcasting**, a plain transfer of
  `balance - 1.2 x gasLimit x gasPrice` to the sweep address (a `cancel` instead when nothing is left). It POSTs that to `/sweep/arm`, sends
  a signed `/sweep/heartbeat` every **2 minutes** while the tab is visible, signs a fresh transfer every **10 minutes** while the tab is open (so a gas price change cannot leave a stale one), and a best-effort `navigator.sendBeacon` on `pagehide`. Failures are silent.
  Closed auctions are also withdrawn automatically (refunds, deferred seller payments), one attempt per auction. **Before every sweep is signed, pending refunds / seller payments are withdrawn first** (the host reads the auction list itself); if one cannot be withdrawn, a cancel is sent instead of a sweep, so a refund is never stranded without gas.
  The signed gas limit is **60000**, not 21000: a plain transfer on Sapphire measures about 22k gas and a 21000 limit reverts (the faucet uses the same 60000).
* **Endpoints** (Function URL): `GET /sweep/config` (public: `{ sweepAddress, chainId, pidMode, serverTime }`; the browser signs its timestamps with the server clock, so a wrong participant clock cannot make cancel/heartbeat signatures expire), `POST /sweep/arm`, `POST /sweep/heartbeat`
  (all three rate limited like `/claim` with their own counters, per 10-minute window: `SWEEP_RATE_LIMIT_PER_WINDOW` default **600** per caller and `SWEEP_GLOBAL_RATE_LIMIT_PER_WINDOW` default **6000**; a whole lab shares one NAT address and every participant heartbeats every 2 minutes. Override via the `sweepRateLimit` / `sweepGlobalRateLimit` template options),
  `GET /admin/sweeps` (`x-admin-password` header: address, pidHash, lastSeen, armed value, status, txHash, returned amount, current idle minutes) and
  `POST /admin/sweep-settings { idleMinutes, password }` (whole minutes, **15**..1440; heartbeats come every 2 minutes, so an active participant is never idle that long).
* **Arm validation** (anything else is refused and nothing is stored): the pid hash belongs to a pid paid to that address, the transaction decodes
  as a signed legacy transfer from that address, `to` is the sweep address (`SWEEP_ADDRESS`, default the faucet address), no data, the configured chain id, gas limit 21000..100000,
  `value + gas <= current balance` and nonce equal to the pending nonce. **Cancel and heartbeat must carry a wallet signature** of `bc-sweep|<action>|<address>|<pidHash>|<ts>` (EIP-191, `ts` within 5 minutes of server time; cancel uses its `signedAt` as `ts`): knowing a pid hash is not enough to cancel or touch a record. A newer arm replaces an older one (an older `signedAt` is ignored).
* **Job** (`SweepJobFunction`, handler `index.sweepJob`, EventBridge `rate(5 minutes)`): for `armed` entries whose `lastSeen` is older than the idle
  minutes (DynamoDB item `config#sweep`, admin-editable; `SWEEP_IDLE_MINUTES`, default 30, until the admin saves one) it re-checks nonce and balance and broadcasts the stored
  transaction **once**. The claim (armed -> sending) is conditional on `lastSeen < idleBefore`, so a heartbeat arriving between the scan and the claim cancels the broadcast. A used nonce or a changed balance marks the entry `stale` (the participant was active; the next arm replaces it). A transient RPC failure is retried
  on the next run, three failures mark it `stale`. Entries become `sent` (with `txHash`), the next run confirms the receipt and adds the amount to `returnedWei`.
  At most 50 broadcasts per run. Records expire by TTL two weeks after the last heartbeat.
* The job role has **no Secrets Manager access** and only `dynamodb:GetItem/UpdateItem/Scan` on the codes table; the faucet role gains `dynamodb:Scan` (admin list).
* Admin Zone: the "Participants gas" card has **Auto-return** (`armed` / `sent` / `stale` / `none`) and **Returned** columns, a faucet-admin-password field with *Load auto-return*, and the idle-minutes setting.
* The browser uses the address from `/sweep/config` (the server decides what it accepts). `REACT_APP_SWEEP_ADDRESS` / `REACT_APP_FAUCET_ADDRESS` are only a fallback when the server gives none; a console warning appears when they differ from the server's.
* The browser loads the participant's closed auctions itself (factory campaigns, `getListSummary`, `getUserAuctionStatus`; no dependence on the auctions list page) before every signature. A failing address is retried (3 attempts, 2 s / 4 s backoff) and then read directly; only an address that might hold funds for the participant and still cannot be read holds the sweep back, and closed auctions found to be irrelevant are not read again. If the auction list itself cannot be read, an auction cannot be read, or a refund / seller payment cannot be withdrawn, a cancel is sent (and re-sent by the timer until the server accepts it); the 10-minute timer and a return to the tab retry and arm once it works.
* Not verified against AWS: the DynamoDB expressions (`putSweep`, `touchSweep`, `claimSweep`, `finishSweep`, Scan) are covered by the memory store contract tests and by `dynamoStore.test.mjs` (a fake client that understands exactly these expressions), not by real DynamoDB.

### Messages from the admin to participants (inbox)

The admin can show a blocking popup to one participant or to everybody ("Message from the experiment team", button **Got it**). It uses no new
infrastructure: items in the existing codes table, the existing Function URL, no template or contract change (the faucet role already has Get/Put/Update/Scan).

* **Storage** (codes table, TTL `expiresAt`, refreshed on every write, 14 days): `inbox#<pidHash>` holds `messages: [{ id, body (<= 1000 chars), createdAt, readAt? }]` (capped at 50, oldest dropped) and `acked` (ids of broadcasts that participant has acknowledged);
  `config#broadcast` holds the send-to-all list (capped at 20). Writes are conditional on a version number and retried, so parallel sends and acks do not overwrite each other. Messages older than the TTL are not delivered even before DynamoDB removes the item.
* **Admin endpoints** (password in the `x-admin-password` header, or `password` in the POST body, checked by the same guard and failure rate limit as the other admin endpoints):
  `POST /admin/messages { pidHash, body }` or `{ all: true, body }` (body trimmed, control characters other than newline/tab removed, 1..1000 characters; the pid hash must belong to a known pid; request size limit 8000 bytes) and
  `GET /admin/messages[?pidHash=...]` (history with read status: per participant `readAt`; broadcasts with `readCount`, or `read` when one participant is asked for). The text is never written to the logs; only `admin_message_sent { to (8-char prefix or "all"), length }`.
* **Participant endpoints**: `GET /inbox?pidHash&address&ts&sig` returns the unread messages (unread direct messages plus broadcasts not yet acknowledged, oldest first, `{ messages: [{ id, body, createdAt }], serverTime }`) and
  `POST /inbox/ack { pidHash, address, ts, sig, ids }` marks them read (idempotent; unknown ids are ignored). Both are signed like the heartbeat: EIP-191 signature of `bc-sweep|inbox|<address>|<pidHash>|<ts>` (action `inbox`) or `...|ack|...` (action `ack`), `ts` within 5 minutes of the server clock,
  and the pid must have been paid to (or reserved for) that very address, so knowing a pid hash is not enough to read someone's messages. The signature travels in the query string so the poll stays a simple cross-origin GET (it is only good for 5 minutes and cannot be used for another action).
  A broadcast is only shown to participants that were paid before it was sent. Rate limit: own counters, per 10-minute window `INBOX_RATE_LIMIT_PER_WINDOW` default **3000** per caller and `INBOX_GLOBAL_RATE_LIMIT_PER_WINDOW` default **30000** (a tab polls every 30 s and a lab shares one address).
* **Browser**: `AdminMessageHost` (next to `AutoSweepHost`, same gating: invisible local wallet of a participant only; never MetaMask mode, the admin override, the admin key slot or an admin address) polls every 30 s while the tab is visible and immediately when the participant returns to it, signing with the server clock from `/sweep/config`.
  It shows one message at a time in a dialog that cannot be dismissed except with **Got it** (plain text, never HTML), remembers shown ids for the page load so nothing opens twice, and retries a failed acknowledgement on the next poll. Failures are silent.
* **Admin Zone**: in the "Participants gas" card, **Send message** per row (dialog with text, history and read status) and **Message all participants**. Both ask for the faucet admin password in the dialog (used per request, dropped when the dialog closes).
  The per-row button needs the participant's pid hash, which comes from the auto-return list: press **Load auto-return** first (a participant appears there after their first heartbeat).
* Not verified against AWS: `getInbox/putInbox/getBroadcast/putBroadcast/listInboxes` are covered by the memory store contract tests and by a fake DynamoDB client in `inbox.test.mjs`, not by real DynamoDB.

## Files

* `adminWalletAuth.js` - verifies the `x-admin-proof` wallet proof and the on-chain admin role (cached)
* `adminAuth.js` - scrypt hashing / constant-time checks for the admin password; `../../scripts/faucet/setAdminPassword.js` creates the hash
* `handler.js` - Lambda logic (`createFaucetHandler` is dependency-injected; `handler` is the AWS entry point)
* `store.js` - DynamoDB store (conditional writes). `memoryStore.js` - test double with the same semantics
* `sweep.js` - auto-return validation and the scheduled job (`runSweepJob`)
* `inbox.js` - admin message limits and the "what is unread" rule (storage in `store.js` / `memoryStore.js`)
* `monitor.js` - balance metric publisher. `template.js` - the CloudFormation template (checked by `scripts/faucet/template.test.mjs`)
* `../../scripts/faucet/pidTools.js`, `generatePids.js`, `createFaucetSecret.js`, `deployFaucet.js`
* Tests: `npm run faucet:test` (unit, no network) and `REQUIRE_LOCALNET=1 npm run faucet:test:flow` (5 parallel participants on localnet)

Not verified here: the DynamoDB store and CloudFormation template were not run against AWS (no deployment was made). The
conditional-expression semantics are standard DynamoDB. `scripts/faucet/dynamoStore.test.mjs` runs the real store against a fake client that understands exactly these expressions (command construction and result handling), and the memory store mirrors the same contract for the handler tests.

## Deploy (do it yourself; nothing here is run automatically)

1. Pick an S3 bucket in the target region for Lambda packages (for example `test-bc-artifacts-<account-id>`).
2. Set the admin password hash first (see "Setting the admin password" below) and create the faucet key in Secrets Manager (prints the secret ARN and the public address only):
   `node scripts/faucet/createFaucetSecret.js --name test-bc-faucet/key --region us-east-1`
3. Fund the printed faucet address with Sapphire Testnet TEST tokens (see `docs/SAPPHIRE_TESTNET_RUNBOOK.md`).
4. Check the template offline: `node scripts/faucet/deployFaucet.js --env test --dry-run`
5. Deploy:
   `node scripts/faucet/deployFaucet.js --env test --region us-east-1 --artifact-bucket test-bc-artifacts-<account-id> --secret-arn <ARN> --admin-secret-arn <ADMIN_ARN> --faucet-address <0x...> --factory-address <FACTORY_0x...> --alert-email you@example.org --origins https://<test-amplify-domain>`
   It prints `REACT_APP_FAUCET_URL` and the table name.
6. Confirm the SNS subscription email.
7. Generate participant codes (CSV with links stays local and git-ignored):
   `node scripts/faucet/generatePids.js --count 50 --table <table> --region us-east-1 --base-url https://<test-amplify-domain> --out faucet-pids-batch1.csv`
8. Set `REACT_APP_FAUCET_URL` in the TEST Amplify app and build it. The whole test setup is described in `docs/TEST_ENVIRONMENT.md`.
