# Test environment: Sapphire Testnet + AWS + separate Amplify app (prepared, NOT deployed)

Nothing here was run against AWS, Amplify or the Sapphire Testnet. Every step is yours. The goal is a test environment that
cannot touch production: separate Amplify app, `test-` prefixed AWS resources, Sapphire **Testnet** only, anonymous participant codes.

## Naming and isolation rules

| Thing | Test name |
|---|---|
| AWS account / profile | a separate account if possible; otherwise a dedicated CLI profile (`--profile test`) |
| CloudFormation stack | `test-bc-faucet` (scripts refuse any name not starting with `test-`) |
| Secrets Manager secret | `test-bc-faucet/key` (refused unless it starts with `test-`) |
| S3 bucket for Lambda packages | `test-bc-artifacts-<account-id>` |
| Amplify app | `test-bc-data-market`, connected to the branch `spike/embedded-wallets-sapphire` only |
| Tags | `Environment=test`, `Project=bc-data-market` (added by the deploy script) |
| Chain | Sapphire Testnet, chain 23295. Mainnet (23294) is refused by every script and by the Lambda |

The deploy script requires `--env test` and refuses the production domain in `--origins`; production resources are never named by these scripts.

## Order of steps (the Amplify domain must exist before the factory is deployed)

1. **Amplify app (console, yours).** AWS Amplify -> New app -> Host web app -> GitHub -> repository `Renana-Lab/bc` -> branch
   `spike/embedded-wallets-sapphire`. App name `test-bc-data-market`. Turn **auto build off** for the branch until step 6
   (Branch settings). Build settings (this repo has no `amplify.yml`; paste into "Build settings"; CRA output is `build`):

   ```yaml
   version: 1
   frontend:
     phases:
       preBuild:
         commands:
           - yarn install --frozen-lockfile --ignore-scripts
       build:
         commands:
           - yarn build
     artifacts:
       baseDirectory: build
       files:
         - '**/*'
     cache:
       paths:
         - node_modules/**/*
   ```

   Use an Amplify build image with Node 20+. Note the default domain, e.g. `https://spike-embedded-wallets-sapphire.<appId>.amplifyapp.com`.
   (`yarn build` = `react-scripts build`; it was run locally with `CI=true` and compiles.)
2. **Production app check (yours).** In the *existing* production Amplify app, confirm branch auto-detection is off or limited to
   the production branch. The repository has a push webhook; this assistant could not verify whether pushing a new branch
   triggers a build there.
3. **Deployer wallet + factory** (see `docs/SAPPHIRE_TESTNET_RUNBOOK.md`): set `FACTORY_SIWE_DOMAIN` to the **host** of the Amplify
   domain from step 1 (no `https://`), then
   `node scripts/sapphire/deployTestnet.js --dry-run` and `--confirm-public-testnet`. The domain is fixed in the contract.
4. **Faucet secret** (key + rate-limit salt go straight to Secrets Manager; only the public address is printed):
   `node scripts/faucet/createFaucetSecret.js --name test-bc-faucet/key --region <region>`.
   Fund the printed address with TEST tokens.
5. **Faucet stack:**
   ```
   node scripts/faucet/deployFaucet.js --env test --dry-run
   node scripts/faucet/deployFaucet.js --env test --region <region> --profile test --artifact-bucket test-bc-artifacts-<account-id> `
        --secret-arn <ARN> --faucet-address <0x...> --alert-email <you> --origins https://<amplify-domain>
   ```
   Confirm the SNS subscription email. Then generate participant codes (CSV stays local, git-ignored):
   `node scripts/faucet/generatePids.js --count <N> --table <printed table> --region <region> --base-url https://<amplify-domain> --out faucet-pids-test1.csv`
6. **Amplify environment variables (test app only), then build:**

   | Variable | Value |
   |---|---|
   | `REACT_APP_NETWORK` | `sapphire-testnet` |
   | `REACT_APP_FACTORY_ADDRESS` | factory address from step 3 |
   | `REACT_APP_WALLET_MODE` | `local` |
   | `REACT_APP_FAUCET_URL` | printed by step 5 |
   | `REACT_APP_MARKET_ENV` | `testing` (labels the market "Development") |

   No keys in Amplify. Enable the build for the branch.
7. **Verify** as in the runbook (one participant link, funds once, bid, winner reads, backup/restore).

## Privacy of the rate-limit records

* Rate-limit counters live in their **own DynamoDB table** (`RateTable`). Their keys are `HMAC-SHA256(secret salt, IP + time window)`:
  not reversible to an IP without the salt (which lives only in Secrets Manager), and different in every window, so a caller cannot be
  tracked across windows. The code table (`FaucetTable`) never contains an IP, hashed or not.
* The rate table has no participant code, no pid digest and no address, and no point-in-time recovery/backups.
* Short TTL: each record expires at the end of its 10-minute window plus 60 seconds. DynamoDB removes expired items in the background,
  typically within days rather than immediately; expired records are never read again (the window is part of the key) and are
  unreadable without the salt. Reduce the exposure further by lowering `RATE_WINDOW_SECONDS`.
* Logs contain no IP and no hashed IP; only event names, an 8-character code-digest prefix and scrubbed errors.
* Join risk that remains: anyone with *both* the salt and read access to the tables during the same window could test a guessed IP
  against the rate table. They could still not link it to a code, because the tables share no identifier.

## Teardown (yours)

`aws cloudformation delete-stack --stack-name test-bc-faucet --profile test` (log groups are retained by design), delete the secret
`test-bc-faucet/key` and the S3 artifacts, and delete the Amplify app `test-bc-data-market`.
