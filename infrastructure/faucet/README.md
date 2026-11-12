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

## Prolific mode, payout cap and the open/closed switch

By default (`FAUCET_PID_MODE=allowlist`) nothing above changes. Set `--pid-mode prolific` to use one shared link for the whole
study: the Prolific participant id (24 hex characters) is the pid, no per-person links are generated, and wallet keys are still
created only in the participant's browser. In both modes the faucet is **closed by default** until an admin opens it.

### Environment variables (all set by `template.js` / `deployFaucet.js`)

| Variable | Deploy flag | Meaning |
|---|---|---|
| `FAUCET_PID_MODE` | `--pid-mode allowlist\|prolific` | Default `allowlist`. In `prolific` mode only `/^[a-fA-F0-9]{24}$/` is accepted (case-folded before hashing); the first claim of a new id inserts its sha256 and then proceeds. Same exactly-once, lease/retry and `already_paid` rules as before. |
| `FAUCET_MAX_PAYOUTS` | `--max-payouts N` | **Required** in prolific mode (positive integer; startup fails otherwise). An atomic counter in the codes table; a new successful payment takes a slot, a released reservation (reverted transfer, empty faucet) gives it back. At the cap, `/claim` answers `403 budget_exhausted`; ids that were already paid still get `already_paid`. Independent of the 10-minute rate limit. |
| `FAUCET_REQUIRED_STUDY_ID` | `--required-study-id` | Optional. If set, `body.studyId` must match (timing-safe), else `403 not_eligible` before anything is reserved. |
| `FAUCET_EXPERIMENT_CODE` | env var `FAUCET_EXPERIMENT_CODE` when running `deployFaucet.js` | Optional static shared string; `body.experimentCode` must match (timing-safe). It is a **shared, non-secret string** (it appears in the participants' links as `?exp=`), so it only keeps out people who know the faucet URL but not the link; it is not a credential. Allowed characters: `[A-Za-z0-9_.~-]`, 1-64. `deployFaucet.js` reads it from the environment and passes it as a CloudFormation `NoEcho` parameter, which does appear in the `aws cloudformation deploy` argument list on the machine that deploys, so do not use anything sensitive. It is never logged by the Lambda. Re-set it on every deploy, otherwise it is cleared. |
| `FAUCET_ADMIN_SECRET_ID` | `--admin-secret-arn` | Secrets Manager secret holding the admin password **hash** (scrypt + salt). Required to deploy; the Lambda role may read it. |
| `FAUCET_AMOUNT_WEI` | `--amount-wei` | Default is now `1500000000000000000` (1.5 TEST). |

Endpoints (Function URL): `POST /claim`, `GET /status` (public, returns only `{ open, updatedAt }`), `POST /admin/state`.
The open/closed state is a DynamoDB item (`config#faucet`); a missing or unreadable item means **closed**. `/claim` answers
`403 faucet_closed` before looking at the pid.

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

### Upgrading an existing allowlist deployment

* The faucet is **closed after the deploy** (no state item exists yet). Open it at `/admin/faucet` before participants arrive.
* `--admin-secret-arn` is now required (create the admin secret first, see above).
* The payout counter (`FAUCET_MAX_PAYOUTS`, prolific mode) is cumulative and cannot be reset: set it to the number of participants
  **plus** the rehearsal/test claims you expect, because those count too.

## Files

* `adminAuth.js` - scrypt hashing / constant-time checks for the admin password; `../../scripts/faucet/setAdminPassword.js` creates the hash
* `handler.js` - Lambda logic (`createFaucetHandler` is dependency-injected; `handler` is the AWS entry point)
* `store.js` - DynamoDB store (conditional writes). `memoryStore.js` - test double with the same semantics
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
   `node scripts/faucet/deployFaucet.js --env test --region us-east-1 --artifact-bucket test-bc-artifacts-<account-id> --secret-arn <ARN> --admin-secret-arn <ADMIN_ARN> --faucet-address <0x...> --alert-email you@example.org --origins https://<test-amplify-domain>`
   It prints `REACT_APP_FAUCET_URL` and the table name.
6. Confirm the SNS subscription email.
7. Generate participant codes (CSV with links stays local and git-ignored):
   `node scripts/faucet/generatePids.js --count 50 --table <table> --region us-east-1 --base-url https://<test-amplify-domain> --out faucet-pids-batch1.csv`
8. Set `REACT_APP_FAUCET_URL` in the TEST Amplify app and build it. The whole test setup is described in `docs/TEST_ENVIRONMENT.md`.
