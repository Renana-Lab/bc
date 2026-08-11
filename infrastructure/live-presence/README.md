# Live Presence

This stack gives the static Amplify website shared live counts without an
always-running application server. It uses a Lambda Function URL and two
on-demand DynamoDB tables.

It stores:

- Anonymous wallet hashes with a 60-second expiry.
- Anonymous bot-wallet hashes with the same expiry.
- The latest observed active-auction count.
- One aggregate activity sample per minute for up to 400 days.

It never receives private keys, wallet balances, bids, auction payloads, the
admin password, or raw IP addresses from the application.

## Deploy

Authenticate the AWS CLI to the account that hosts the site, then run:

```powershell
yarn presence:deploy --region us-east-1
```

The command prints a `REACT_APP_PRESENCE_API_URL` value. Add it to both the
production and testing branches in the AWS Amplify environment-variable page,
then redeploy those branches.

To restrict browser access to additional deployment domains:

```powershell
yarn presence:deploy --region us-east-1 --origins "https://datamarketplaces.net,https://branch.example.amplifyapp.com,http://localhost:3000"
```

The deployment is idempotent. Run the same command to update the stack after
changing `handler.js`.

## Presence definitions

- A user or admin is online while a connected-wallet heartbeat is newer than
  60 seconds.
- The same wallet in multiple tabs counts once. An authenticated admin session
  takes precedence over a regular user session for the same wallet.
- A bot is online while it is enabled, running, and its hosting browser is
  sending heartbeats. Duplicate tabs for the same bot wallet count once.
- Active auctions come from the website's chain-backed active-auction registry.

The API returns aggregate counts only. Individual presence records are not
exposed to browsers.

