# Sapphire Testnet runbook (prepared, NOT executed)

See `docs/TEST_ENVIRONMENT.md` for the full test setup (separate Amplify app, `test-` AWS resources). This file covers the on-chain part.

Nothing in this document was run by the assistant. Every step below that sends a transaction or creates AWS resources is
yours to run. Testnet is a public network; use a dedicated deployer wallet that holds only TEST tokens.

## 0. Prerequisites

* Node 18+, `yarn install` done, `npm run sapphire:compile` run (the build JSONs are committed, so this is optional).
* AWS CLI authenticated to the account that hosts the site (for the faucet stack).
* The host users will open the app on: the **test** Amplify app's domain (see `docs/TEST_ENVIRONMENT.md`), for example `spike-embedded-wallets-sapphire.<appId>.amplifyapp.com` (**fixed forever in the factory**: SIWE sign-in only
  works on that exact host; a different host later means redeploying the factory).

## 1. Deployer wallet and TEST tokens

1. Create a fresh deployer wallet (any wallet; do not reuse a lab or personal wallet). Keep its private key out of files.
2. Get Sapphire Testnet TEST tokens for its address from the Oasis Testnet faucet (see https://docs.oasis.io for the current faucet URL).
   Deployment costs well under 1 TEST; participants' faucet money comes from the *faucet* wallet in step 4, not from this one.

## 2. Deploy the factory (the only on-chain step here)

PowerShell, in the repo root:

```powershell
$env:DEPLOY_PRIVATE_KEY = "0x<deployer key>"      # this shell session only; do NOT put it in .env
$env:FACTORY_SIWE_DOMAIN = "spike-embedded-wallets-sapphire.<appId>.amplifyapp.com"   # the TEST Amplify app host
node scripts/sapphire/deployTestnet.js --dry-run                  # checks only: nothing is sent
node scripts/sapphire/deployTestnet.js --confirm-public-testnet   # sends the deployment transaction
```

The wrapper refuses to run if the key is in `.env`, the domain is `localhost`/has a scheme, or the flag is missing. It calls
`src/real_ethereum/deploy.js` with `DEPLOY_NETWORK=sapphire-testnet` (chain 23295, `https://testnet.sapphire.oasis.io`); the
constructor payload is sent through the Sapphire wrapper. It prints `CampaignFactory deployed at: 0x...` and writes
`REACT_APP_REAL_FACTORY_ADDRESS` to the git-ignored `.env`. Then close the shell (or `Remove-Item Env:DEPLOY_PRIVATE_KEY`).

## 3. Smoke check the factory (read-only)

Open the browser console on any page of the app after step 6, or run a read call: `factory.domain()` must equal your host.

## 4. Faucet stack on AWS (see `infrastructure/faucet/README.md`)

1. `node scripts/faucet/createFaucetSecret.js --name test-bc-faucet/key --region <region>` -> prints the secret ARN and the faucet address.
2. Send TEST tokens to that faucet address (budget: participants x `--amount-wei`, plus gas of up to about 0.007 TEST per payment (measured use is about 22k gas, roughly 0.0022 TEST)).
3. `node scripts/faucet/deployFaucet.js --env test --dry-run` (offline check), then deploy with the command in the README
   (`--secret-arn`, `--faucet-address`, `--artifact-bucket`, `--alert-email`, `--origins`, optionally `--amount-wei`, `--low-balance`).
4. Confirm the SNS email so the low-balance alarm can reach you.
5. `node scripts/faucet/generatePids.js --count <N> --table <table> ... --out faucet-pids-batch1.csv`; hand each participant their own link.

## 5. Amplify environment variables

Set on the **test** Amplify app (never the production app), then build:

| Variable | Value |
|---|---|
| `REACT_APP_NETWORK` | `sapphire-testnet` |
| `REACT_APP_FACTORY_ADDRESS` | address printed in step 2 |
| `REACT_APP_WALLET_MODE` | `local` |
| `REACT_APP_FAUCET_URL` | printed by the faucet deployment |

Do not set any key in Amplify. (This repo's Amplify build is triggered by pushes; confirm which branch it builds before pushing.)

## 6. Verify with one participant (you)

1. Open `https://<host>/?pid=<one code>` in a clean browser profile. Create a wallet, click "Request test funds".
2. Confirm the balance arrives. A second click or a second browser with the same code and wallet returns the original payment (no second payment); a different wallet with the same code is refused.
3. Create an auction (seller wallet), bid from the participant, let it end, finalize, and click "View data" as the winner.
4. Download the encrypted backup, clear site data, restore from the backup.

## 7. Operations

* Balance alarm: below `--low-balance` TEST (or no metric) emails the subscribed address. Top up the faucet address.
* More codes: run `generatePids.js` again with a new `--out` file.
* Costs and cleanup: `aws cloudformation delete-stack --stack-name test-bc-faucet` removes the stack (log group and secret are retained; delete the secret separately).
