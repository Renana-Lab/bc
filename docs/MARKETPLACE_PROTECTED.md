# Marketplace Protected

This branch is an isolated Sepolia marketplace variant. It must not replace an
existing deployment or advertise historical public data as newly confidential.

## Trust Boundary

New private text is encrypted in the browser before upload using AES-256-GCM.
S3 stores the ciphertext envelope, DynamoDB holds metadata and wrapped data keys,
and KMS protects the wrapping key. The release service independently checks the
contract before wrapping a data key for a verified recipient. AWS administrators
with sufficient permissions can recover data keys. This is not zero-knowledge
storage, and recipients can redistribute data they have decrypted.

At upload completion, the service verifies AES-GCM authentication and UTF-8
decodability with the unwrapped key before pinning the object version. Plaintext
is held only in transient buffers during this check, never returned or stored.
This proves decryptability, not that the data matches the seller's description.
The contract does not enforce an upload receipt; direct contract calls can
still create references the service will refuse to release.

The description, auction prices, participants, and transaction metadata remain
public. Never place private information in the description. Already-public
Sepolia payloads cannot be erased or made private by importing an encrypted copy.

## Isolation

- Branch and Amplify app: `marketplace-protected`.
- Amplify Hosting: `us-east-2` (Ohio). Existing encryption infrastructure: `us-east-1`.
- Separate factory, encrypted-payload API, S3 bucket, DynamoDB table and KMS key.
- No existing factory addresses, budgets or marketplace databases are modified.
- No private keys, AWS credentials or server RPC credentials belong in any
  `REACT_APP_` value or client bundle.
- Archives are read-only records and never receive bids or move funds.

## Verification Before Sharing

1. Run `npm run protected:compile` and `npm run protected:test`.
2. Run the existing bot, budget, registry, report and browser regression suites.
3. Build the blockchain variant with the protected feature flag and verify that
   the creation UI cannot fall back to a legacy plaintext transaction.
4. Use a unique dummy marker. Inspect transaction input, contract getters,
   events, payload records, browser persistence, reports and logs for leakage.
5. Complete an auction after the seller closes its browser. The winner must
   decrypt from another device; a losing participant must be denied.
6. Test expired sessions, key substitution, replay, wrong networks, RPC failure,
   missing payload versions, retries, and wallet changes.
7. Measure cold and warm release latency and compare trading interaction times
   against the unmodified baseline. Never label unmeasured targets as achieved.
8. Verify the actual Amplify build ID and direct links before sharing its URL.

Real macOS Chrome with MetaMask is a required manual verification. WebKit tests
are supplementary, not a substitute. Do not mark this release verified until
live AWS, Sepolia and real-wallet checks have passed.

## Recovery

Keep KMS keys and committed S3 object versions. Do not delete them during
rollback: existing auctions still need key release. Restore DynamoDB metadata
and ciphertext versions together. Retain original archive provenance and never
reconstruct bid transactions or balances from archive rows.

## Deployed Resources

- Preview: https://main.d1n93p6nqw0kho.amplifyapp.com/
- Protected Sepolia factory: `0xc52f7A33010E525dcC1821F533e96B381C3879c2`.
- Key API: https://c53tm1of1k.execute-api.us-east-1.amazonaws.com
- Stack: `marketplace-protected`, AWS account `774490039997`, `us-east-1`.
- S3: `marketplace-protected-bucket-ihpkz41ajcxv` (private, versioned).
- DynamoDB: `marketplace-protected-Table-OIE309CC05L7` (PITR, deletion protection).
- KMS: `3be9a069-b6ce-4488-8686-ecde73dc414b`, RSA-3072.
- Separate Lambda functions: `marketplace-protected-service` and
  `marketplace-protected-finalizer`. Only the finalizer role reads its signing secret.
- Admin links lead directly to objects, records, key, functions, logs and Amplify.

The committed `.env.protected` contains public configuration only. GitHub Actions
uses OIDC restricted to `Renana-Lab/bc` on `marketplace-protected`, and can deploy
only the new Amplify app. AWS resource/code updates remain explicit administrative
operations using `scripts/protected/deployService.js`. Do not deploy infrastructure
while an archive import is running. Retain the resource stack and keys on rollback.

For a local protected preview, use `npx vite --mode protected`; the standard build
without that mode remains the legacy blockchain variant. Node bots require
`REACT_APP_PROTECTED_MARKET=true` and the explicit protected
`REACT_APP_FACTORY_ADDRESS`; conflicting factory overrides are rejected. Their
default storage is `botnet-data/protected`, isolated from legacy bots. Protected
experiment outputs use `experiment-data/runs/protected`. Delivery keys are ignored
by Git; protect local file permissions/backups and never upload them as artifacts.
