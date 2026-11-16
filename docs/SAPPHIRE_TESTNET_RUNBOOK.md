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

This factory has an **admin role** (owner + admins) and deploys each auction as an EIP-1167 clone. There is no migration:
a NEW factory is deployed and `REACT_APP_FACTORY_ADDRESS` is pointed at it (auctions on the old factory are abandoned).
The owner is a constructor argument, never hardcoded in the contract. For this deployment the owner is
`0xa38C101659f5a1DC28745c47746e0ae84b574D26` (it also needs to be in `REACT_APP_ADMIN_ADDRESSES` to see the Admin Zone).

Steps, in order:

```powershell
npm run sapphire:compile                                   # regenerates src/real_ethereum/build/*.json (commit them)
# with sapphire-localnet running (docker run -d -p8544-8548:8544-8548 ghcr.io/oasisprotocol/sapphire-localnet):
$env:REQUIRE_LOCALNET = "1"; npm run sapphire:test         # confidentiality + admin tests must all pass

$env:DEPLOY_PRIVATE_KEY = "0x<deployer key>"      # this shell session only; do NOT put it in .env
$env:FACTORY_SIWE_DOMAIN = "spike-embedded-wallets-sapphire.<appId>.amplifyapp.com"   # the TEST Amplify app host
$env:FACTORY_OWNER_ADDRESS = "0xa38C101659f5a1DC28745c47746e0ae84b574D26"             # factory owner and first admin
node scripts/sapphire/deployTestnet.js --dry-run                  # checks only: nothing is sent
node scripts/sapphire/deployTestnet.js --confirm-public-testnet   # sends the deployment transaction
```

After the deploy:

1. Copy the printed `CampaignFactory deployed at: 0x...` address into Amplify `REACT_APP_FACTORY_ADDRESS` (test app) and redeploy the site.
2. Verify read-only: `factory.domain()` equals the host, `factory.owner()` and `factory.isAdmin(owner)` match `FACTORY_OWNER_ADDRESS`.
3. Browsers that used the old factory keep a stored factory-address override only while the env address is unchanged; a new
   `REACT_APP_FACTORY_ADDRESS` always wins and the stale override is deleted automatically.
4. Further admins are added by the owner in the Admin Zone ("Admins" card) or with `factory.addAdmin(address)`.

The wrapper refuses to run if the key is in `.env`, `FACTORY_OWNER_ADDRESS` is missing/invalid/zero, the domain is `localhost`/has a scheme, or the flag is missing. It calls
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
| `REACT_APP_FAUCET_ADDRESS` | public address of the faucet wallet (optional; lets the Admin Zone show its live balance before the admin status is loaded) |
| `REACT_APP_ADMIN_ADDRESSES` | admin wallet addresses (comma separated). They see the wallet panel, the "Participants gas" and "Faucet funds" cards |
| `REACT_APP_LOCAL_WALLET_PASSPHRASE` | leave unset. `required` brings back the old passphrase wallet panel for everyone |

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


### Auto-return of leftover TEST (redeploy, scheduler, IAM)

Participants' leftover TEST goes back to the faucet wallet after they were inactive (details: `infrastructure/faucet/README.md`, "Auto-return").

1. **Redeploy the faucet stack** with the same `deployFaucet.js` command as before (the stack is updated in place). Optional environment variables for the deploy command:
   `SWEEP_ADDRESS=<0x...>` (default: `--faucet-address`) and `SWEEP_IDLE_MINUTES=<n>` (default 30; the admin can change it later, 15..1440).
2. **Scheduler**: nothing to create by hand. The template adds `SweepJobFunction` plus an EventBridge rule `rate(5 minutes)` and its invoke permission. Check in the console that rule `SweepSchedule` is ENABLED.
3. **IAM** (created by the template, listed for review): the faucet role gains `dynamodb:Scan` on the faucet table; the new job role has `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:Scan` on the faucet table and nothing else (no secrets). The deploying principal needs permission to create these roles (already required, `CAPABILITY_IAM`).
   The job reserves concurrency 1 like the faucet function (one more unit of the account concurrency quota; `--reserved-concurrency 0` skips it).
4. **Amplify**: no new variable is required. `REACT_APP_SWEEP_ADDRESS` is only a fallback: the browser signs to the address the server reports at `/sweep/config` (a console warning shows when they differ). Rebuild the app.
5. **Verify**: open `/admin/faucet`-style admin zone > Participants gas, enter the faucet admin password, *Load auto-return*. A participant with funds shows `armed` a few seconds after loading the app. Set a short idle time (minimum 15) for a rehearsal: close the tab, wait idle time + up to 5 minutes, the status becomes `sent` and then the returned amount is filled in. Restore 30 afterwards.
6. **Rollback**: delete `SweepSchedule` (or set its state to DISABLED) to stop all broadcasts; stored transactions stay inert and expire by TTL.

## Invisible wallet for participants (`REACT_APP_WALLET_MODE=local`, default)

* The first visit creates a wallet automatically, one per participant id per browser (`?pid=`). The private key is encrypted with a WebCrypto
  AES-GCM key created with `extractable: false` and kept as a `CryptoKey` in IndexedDB (database `data-market-local-wallet`, store `silent`);
  only IV + ciphertext are stored. Reloads decrypt silently. Nothing is typed, there is no lock screen. This protects against casual reads of storage, not
  against script running on the origin: **testnet funds only**.
* A browser that still holds an old passphrase keystore shows the unlock step once, then re-saves the key silently and deletes the keystore.
* Participants never see the wallet, balance, address, backup or faucet button. With `REACT_APP_FAUCET_URL` and a pid, funds are claimed automatically
  once per page load when the balance is below 0.05 TEST ("Preparing your session..." meanwhile; failures are silent). A failed action because of a low balance
  only shows "Please wait a moment and try again." Admins watch **Admin Zone > Participants gas** and top up (never automatic).
* Admins: wallet panel (address, TEST balance, passphrase-encrypted backup, request test funds) is shown only for addresses in `REACT_APP_ADMIN_ADDRESSES`.
  Restore the admin key from a backup on `/admin/wallet`.
* Admin sign-in with MetaMask in a `local` build: `/admin-login` (linked from the drawer under "Admin Zone"). Only an address on `REACT_APP_ADMIN_ADDRESSES`
  sets the session override `sessionStorage.walletModeOverride = "metamask"` (only that value is accepted) and opens the Admin Zone. While it is active no wallet is
  created, no faucet claim is made and the participant wallet in IndexedDB is untouched. **Switch back to participant wallet** (Admin Zone) clears it and reloads.
  Fallback "Import admin key" (testnet keys only) seals a pasted key under the separate `admin` slot (`sessionStorage.walletScopeOverride = "admin"`).
* The on-chain owner/admin check is not available on this branch (contracts untouched); the page accepts an `extraAdminCheck` hook for it.
