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
| Fixed, configurable amount | `FAUCET_AMOUNT_WEI` (deploy flag `--amount-wei`, default 0.1 TEST). |
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

## Files

* `handler.js` - Lambda logic (`createFaucetHandler` is dependency-injected; `handler` is the AWS entry point)
* `store.js` - DynamoDB store (conditional writes). `memoryStore.js` - test double with the same semantics
* `monitor.js` - balance metric publisher. `template.js` - the CloudFormation template (checked by `scripts/faucet/template.test.mjs`)
* `../../scripts/faucet/pidTools.js`, `generatePids.js`, `createFaucetSecret.js`, `deployFaucet.js`
* Tests: `npm run faucet:test` (unit, no network) and `REQUIRE_LOCALNET=1 npm run faucet:test:flow` (5 parallel participants on localnet)

Not verified here: the DynamoDB store and CloudFormation template were not run against AWS (no deployment was made). The
conditional-expression semantics are standard DynamoDB. `scripts/faucet/dynamoStore.test.mjs` runs the real store against a fake client that understands exactly these expressions (command construction and result handling), and the memory store mirrors the same contract for the handler tests.

## Deploy (do it yourself; nothing here is run automatically)

1. Pick an S3 bucket in the target region for Lambda packages (for example `test-bc-artifacts-<account-id>`).
2. Create the faucet key in Secrets Manager (prints the secret ARN and the public address only):
   `node scripts/faucet/createFaucetSecret.js --name test-bc-faucet/key --region us-east-1`
3. Fund the printed faucet address with Sapphire Testnet TEST tokens (see `docs/SAPPHIRE_TESTNET_RUNBOOK.md`).
4. Check the template offline: `node scripts/faucet/deployFaucet.js --env test --dry-run`
5. Deploy:
   `node scripts/faucet/deployFaucet.js --env test --region us-east-1 --artifact-bucket test-bc-artifacts-<account-id> --secret-arn <ARN> --faucet-address <0x...> --alert-email you@example.org --origins https://<test-amplify-domain>`
   It prints `REACT_APP_FAUCET_URL` and the table name.
6. Confirm the SNS subscription email.
7. Generate participant codes (CSV with links stays local and git-ignored):
   `node scripts/faucet/generatePids.js --count 50 --table <table> --region us-east-1 --base-url https://<test-amplify-domain> --out faucet-pids-batch1.csv`
8. Set `REACT_APP_FAUCET_URL` in the TEST Amplify app and build it. The whole test setup is described in `docs/TEST_ENVIRONMENT.md`.
