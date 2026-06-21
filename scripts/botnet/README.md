# BC Botnet Service

This is the absorbed botnet layer for the Blockchain Data Market app.

It runs outside the browser as a Node service because bots need private keys,
RPC access, timers, and write transactions. The Admin Zone controls it through
the `/api/botnet` HTTP API.

## Runtime

```bash
npm run botnet:api
```

Default API:

```text
http://localhost:3002/api/botnet
```

In local React development, `src/setupProxy.js` forwards `/api/botnet` to
`http://127.0.0.1:3002` by default. If the Bot Command Center shows 404 or 502
for `/api/botnet/...`, start this service or point the frontend at a deployed
botnet API:

```env
REACT_APP_BOTNET_API_URL=https://your-botnet-host.example.com/api/botnet
BOTNET_PROXY_TARGET=http://127.0.0.1:3002
```

For production, deploy this Node service behind HTTPS and set the frontend env:

```env
REACT_APP_BOTNET_API_URL=https://your-botnet-host.example.com/api/botnet
```

Docker build from the repository root:

```bash
docker build -f scripts/botnet/Dockerfile -t bc-botnet .
docker run -p 3002:3002 --env-file .env bc-botnet
```

## Required Secrets

```env
RPC_URL=https://sepolia.infura.io/v3/...
INFURA_KEY=...
FACTORY_ADDRESS=0xec38565FAeeef009F57037F2804D186928E63629
BOTNET_ADMIN_TOKEN=optional-api-token
```

Bots are stored in `botnet-data/bots.json` by the API. This file is ignored by
git because it contains private keys.

## Private Key Uploads

The Admin Zone Bot Command Center includes an **Upload Keys** button. Upload a
`.txt`, `.csv`, `.json`, or `.env`-style file containing one private key per
line or embedded in structured text. The importer accepts both `0x`-prefixed
and plain 64-hex private keys.

Assignment rules:

- duplicate keys already assigned to bots are skipped;
- bots with missing or invalid keys are filled first;
- extra keys create new enabled `Uploaded Bot N` profiles;
- keys are saved only in the runtime bot storage, not in tracked git files.

Import the existing local botnet profiles:

```bash
npm run botnet:import
```

The importer reads:

```text
C:\Users\Programmers\Desktop\bc_SUPERBOT\files\data\bots.json
```

You can override the source path:

```bash
npm run botnet:import -- C:\path\to\bots.json
```

For GitHub Actions one-shot cycles, store the bot list in a secret:

```env
BOTNET_BOTS_JSON=[{"name":"Bot A","privateKey":"0x...","enabled":true}]
```

## Admin API

```text
GET  /api/botnet/health
GET  /api/botnet/status
GET  /api/botnet/bots
GET  /api/botnet/logs
POST /api/botnet/bots
POST /api/botnet/bots/private-keys
POST /api/botnet/bots/start
POST /api/botnet/bots/stop
POST /api/botnet/bots/run-once
POST /api/botnet/bots/delete
POST /api/botnet/start-network
POST /api/botnet/stop-network
POST /api/botnet/run-network
```

If `BOTNET_ADMIN_TOKEN` is set, send it as:

```text
X-Botnet-Token: your-token
```

## What The Bot Cycle Does

Each enabled bot:

- Reads all auctions from the configured factory.
- Finalizes its own ended seller auctions when finalization is enabled.
- Reads its current on-chain budget.
- Picks one open auction per cycle.
- Skips auctions where it is the seller, already winning, too close to ending,
  too expensive, or outside the bot's max bid settings.
- Sends an incremental bid when eligible.

This keeps the original botnet behavior, but the code now lives inside `bc` and
uses the same ABI and factory-address conventions as the rest of the app.
