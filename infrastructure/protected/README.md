# Protected payload service protocol

All routes use JSON. `Origin` must match the configured exact allowlist. Addresses
and hashes are normalized to lowercase. HTTP errors contain only a stable `error`
code and a request ID, never payloads, signatures, tokens, or underlying RPC errors.

- `GET /config`: `{chainId,factory,publicKey,kmsKeyId,version:1,confirmations:12}`.
  `publicKey` is base64 DER SPKI RSA-3072 OAEP SHA-256.
- `GET /archives?cursor=opaque`: `{archives:[publicMetadata],nextCursor}`. Each
  request queries at most 50 indexed records. Continue while nextCursor is non-null,
  including empty pages. Cursors are base64url encoded, validated archive-only keys.
- `POST /challenge`: `{wallet,publicKey}` -> `{challengeId,typedData,expiresAt}`.
  Sign the returned EIP-712 typedData using `eth_signTypedData_v4`.
- `POST /session`: `{challengeId,signature}` -> `{token,expiresAt,wallet,keyHash}`.
  Tokens expire in one hour; challenges expire in five minutes and consume once.
- `POST /uploads` with `Authorization: Bearer token`:
  `{nonce,ciphertextHash,wrappedKey,envelopeBytes}` -> `{id,uploadUrl,expiresIn:300}`.
  envelopeBytes is the exact UTF-8 byte length of JSON.stringify(envelope), maximum
  1,400,000. The presigned request binds Content-Length and Content-Type.
  PUT **exact UTF-8 JSON.stringify(envelope)** bytes to `uploadUrl`, with
  `Content-Type: application/json`. Envelope is
  `{version:1,context:{chainId,factory,seller,nonce},iv,ciphertext}`.
- `POST /uploads/:id/complete` with bearer token, empty body ->
  `{id,ciphertextHash,ready:true}`. This pins the S3 version and verifies hash,
  envelope context, AES dimensions, and KMS ciphertext/key dimensions. It is
  idempotent. Only create the auction after ready=true.
- `POST /release`: `{auction,publicKey}` without session for transaction-bound
  public keys; `{auction}` with bearer token for signed-session recovery. Optional
  publicKey with session must match the session. Returns
  `{wrappedKey,downloadUrl,ciphertextHash,id,version:1,expiresIn:60}`.
  wrappedKey is base64 RSA-OAEP SHA256 encrypted AES key. GET downloadUrl returns
  the envelope. No raw key/content is ever returned by the API.

`id` = keccak256(abi.encode(chainId,factory,seller,nonce)). `keyHash` = SHA256 of
decoded SPKI DER, 0x-prefixed, matching the shared crypto module. Factory membership,
campaign factory, ID/hash and role are read at a single block 12 confirmations
behind head. Winner must be nonzero, auction ended and closed. Seller is always
eligible once the uploaded record is bound by the actual on-chain payload.

Deploy script accepts --factory, --rpc-url, --origins (comma separated), --region,
--stack-name and --profile. It never modifies frontend or existing deployments.
Dependencies are installed only into an ignored temporary packaging directory.
AWS secret/API-key-bearing RPC URLs must be provided through --rpc-secret-arn
(Secrets Manager), not --rpc-url. Runtime logs exclude request bodies and errors.
Node >=20 is required. See service.test.js for adapter contract and adversarial tests.
