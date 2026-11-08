# Protected Legacy Archive

This tool creates encrypted **copies** of closed legacy auctions. Original Sepolia
storage, calldata and events remain public permanently. Copies carry the label
`Encrypted copy of previously public information`. They are not new auctions and
must not appear in active-auction queues, change budgets, send funds or replay bids.

## Inspect First

```powershell
node scripts/protected/archiveImport.js --rpc $env:RPC_URL --source-factory 0xSOURCE_FACTORY --manifest artifacts/backend/protected/archive-manifest.json
```

Dry-run is the default. It performs read-only RPC calls and only writes a public
manifest when `--manifest` is supplied. The source chain defaults to Sepolia
11155111. `--block NUMBER` pins a specific block; otherwise head minus 12 is used.
At least 12 confirmations are required. A saved manifest pins restarts to its
original block/hash. `--limit` defaults to 100 and fails rather than silently
truncating a larger source factory. Raise it explicitly after inspection.

Every source read uses that block. Factory membership, campaign factory, seller,
winner, close state and end timestamp are checked. Open/unfinalized auctions are
skipped. No-bid archives retain seller identity and a zero winner. Source identity
is chain + factory + auction, so repeated snapshots cannot create duplicate copies.
The manifest contains public metadata and hashes, never the legacy data itself.

## Administrative Execution

```powershell
$env:PROTECTED_SERVICE_FUNCTION="NAME_FROM_PROTECTED_STACK_OUTPUT"
node scripts/protected/archiveImport.js --execute --rpc $env:RPC_URL --source-factory 0xSOURCE_FACTORY --target-factory 0xPROTECTED_FACTORY --manifest artifacts/backend/protected/archive-manifest.json --checkpoint artifacts/backend/protected/archive-checkpoint.json --adapter scripts/protected/archiveIamAdapter.js --aws-account 774490039997 --profile presence-deploy
```

Use real addresses. This tool never submits blockchain transactions, even with
`--execute`. It verifies the AWS CLI caller against the explicitly supplied account
and requires a trusted local administrative adapter. **There is deliberately no
browser password, public import URL, or unauthenticated migration fallback.** If
the deployed service does not implement an IAM-only archive pathway, execution
must remain disabled until that dependency exists.

The included adapter uses AWS CLI `lambda invoke` with IAM credentials, never the
frontend session. Direct events are `{adminAction:'config'}`, `{adminAction:'lookup',
archiveId}` or `{adminAction:'import',body:request}`. The service must reject admin
events arriving through API Gateway. Grant `lambda:InvokeFunction` only for the
specific protected service function. Source factories require a server allowlist.

Custom administrative adapters export:

```javascript
async function createArchiveAdminAdapter({ identity, profile, region }) {
  // Use AWS SDK credential providers or CLI, never a frontend administrator token.
  return {
    authKind: 'aws-iam',
    async getEncryptionConfig() { /* return { publicKey: base64KmsSpki }; */ },
    async lookupArchive(archiveId) { /* return immutable receipt or null; */ },
    async importArchive(request) { /* validate and atomically persist; return receipt; */ },
  };
}
module.exports = { createArchiveAdminAdapter };
```

`authKind` is a local adapter contract, not an authentication enforcement mechanism.
AWS IAM must enforce the administrative permission remotely. Do not accept
untrusted adapter files: they execute with the administrator's local privileges.

`importArchive` receives `{ idempotencyKey, metadata, context, envelope, wrappedKey,
ciphertextHash }`; it never receives plaintext. `metadata` includes archiveId,
source chain/factory/auction/pinned block/hash, seller/winner, closed flag, highest
bid, minimum, end time, public description, payloadHash, snapshotHash and label.
Context uses the protected target factory, original seller and archiveId as nonce.
The shared crypto module seals in memory using the KMS public key. No plaintext
is written to disk. JavaScript strings cannot be reliably zeroized from memory.

The service must independently verify the canonical source snapshot and its
12-confirmation depth, authenticate administrator IAM, validate context/envelope/
hash/KMS key, verify the wrapped AES key decrypts the envelope, then store an
immutable S3 object version and metadata atomically/idempotently. It must reject
conflicting source identities. A source reorg detected during processing requires
quarantining affected records; key release must always revalidate canonical source
eligibility, not trust imported metadata alone. Seller access is allowed; winner
access requires closed/paid state and nonzero winner. A frontend label is not an
authorization check.

Receipt shape: `{ archiveId, snapshotHash, ciphertextHash, recordId }`, where
recordId identifies an immutable administrative archive record. The checkpoint
contains only receipts, is replaced atomically after each successful import and
is reconciled remotely on restart. Remote lookup covers crashes between upload
and local checkpoint persistence. Keep manifest/checkpoint together; never delete
the manifest and reuse its checkpoint at a different block. The service remains
the final authority for atomic duplicate prevention across parallel processes.

Errors are deliberately redacted because RPC exceptions can echo historical
plaintext. Diagnose using AWS audit metadata, not verbose request/response logs.

### Pruned Historical State

Some public RPC nodes cannot execute old-state calls, even while another node at
the same URL can. Do not bypass import verification or overwrite committed copies.
Keep the failed manifest/checkpoint, and use NEW output paths with
`--execute --reuse-verified` to reconcile at a fresh confirmed block. Existing
records are fetched through bounded IAM-only lookup batches. Their snapshot hashes,
immutable ownership/content, and original canonical block hashes must still match;
their original source metadata and ciphertext receipts are retained. Only missing
records receive fresh snapshots and encrypted objects. Two bounded workers stop
assigning new work after a failure; remote/local idempotency covers safe retries.

Key release for a previously verified closed record rechecks the original block's
canonical hash and independently rereads its immutable ownership/content at a fresh
12-confirmed block. It must match the stored verified snapshot exactly. This avoids
requiring an archive node forever for a closed, immutable contract. Import itself
always verifies the exact recorded historical state. An authenticated RPC with
adequate capacity is still recommended; public endpoints have no availability SLA.

## Tests

```powershell
node --test scripts/protected/archiveCore.test.js scripts/protected/archiveIntegration.test.js
```

The isolated tests cover closure boundaries, pinned-block reorgs, factory mismatch,
inconsistent winner state, no-bid archives, plaintext-free manifests/uploads,
checkpoint reconciliation, retries, receipt tampering and safe CLI defaults.
End-to-end IAM, S3/KMS verification and seller/winner release tests are additional
integration gates; mocked adapter tests do not prove deployment readiness. The
local integration test deploys a legacy factory on in-process Ganache, closes a
real auction and performs AES/RSA encryption and delivery without mutating the
source chain during archive import. It does not prove AWS deployment readiness.
