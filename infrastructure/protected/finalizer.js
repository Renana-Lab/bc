'use strict';
// Separate function/role: the release service never receives the automation signer.
const run = async () => {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
  const { JsonRpcProvider, Wallet, Contract, FetchRequest } = require('ethers');
  const secrets = new SecretsManagerClient({});
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const TableName = process.env.TABLE_NAME;
  const pk = 'finalizer:cursor';
  try {
    const secret = (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SIGNER_SECRET_ARN }))).SecretString;
    const privateKey = secret.startsWith('{') ? JSON.parse(secret).privateKey : secret;
    const rpc = process.env.RPC_SECRET_ARN ? (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.RPC_SECRET_ARN }))).SecretString : process.env.RPC_URL;
    const record = (await db.send(new GetCommand({ TableName, Key: { pk }, ConsistentRead: true }))).Item;
    for (const url of rpc.split(',')) {
      let writeStarted = false;
      try {
      const request = new FetchRequest(url.trim()); request.timeout = 4000;
      const provider = new JsonRpcProvider(request);
      if (Number(BigInt(await provider.send('eth_chainId', []))) !== Number(process.env.CHAIN_ID)) continue;
      const signer = new Wallet(privateKey, provider);
      if (await provider.getTransactionCount(signer.address, 'pending') !== await provider.getTransactionCount(signer.address, 'latest')) return { ready: true, skipped: 'pending_transaction' };
      const factory = new Contract(process.env.FACTORY_ADDRESS, ['function getDeployedCampaigns() view returns (address[])', 'function checkEndedAuctionsRange(uint256,uint256) returns (uint256,uint256)'], signer);
      const all = await factory.getDeployedCampaigns();
      const count = all.length;
      if (!count) return { ready: true, scanned: 0 };
      const cursor = Number(record?.cursor || 0) % count;
      const block = await provider.getBlock('latest');
      const states = await Promise.all(all.slice(cursor, cursor + 10).map(async address => {
        const campaign = new Contract(address, ['function closed() view returns(bool)', 'function endTime() view returns(uint256)', 'function finalizeAuctionIfNeeded()', 'function nextRefundIndex() view returns(uint256)', 'function getAddresses() view returns(address[])', 'function processRefunds(uint256)'], signer);
        const [closed, endTime] = await Promise.all([campaign.closed(), campaign.endTime()]);
        return { campaign, closed, ended: endTime <= BigInt(block.timestamp) };
      }));
      let transaction;
      const pendingAuction = states.find(x => !x.closed && x.ended);
      const deferRange = () => db.send(new PutCommand({ TableName, Item: { pk, cursor: (cursor + 1) % count } }));
      if (pendingAuction) {
        writeStarted = true;
        // Estimate the real operation, not a batch that catches inner out-of-gas
        // failures and can therefore appear successful without finalizing.
        const tx = await pendingAuction.campaign.finalizeAuctionIfNeeded();
        transaction = tx.hash;
        const receipt = await tx.wait(1, 35000);
        if (!receipt || receipt.status !== 1) { await deferRange(); return { ready: false, error: 'transaction_unconfirmed' }; }
        if (!await pendingAuction.campaign.closed()) { await deferRange(); return { ready: false, error: 'finalization_not_observed' }; }
        await db.send(new PutCommand({ TableName, Item: { pk, cursor } }));
        return { ready: true, finalized: true, transaction };
      } else {
        for (const state of states.filter(x => x.closed)) {
          const [index, contributors] = await Promise.all([state.campaign.nextRefundIndex(), state.campaign.getAddresses()]);
          if (index < BigInt(contributors.length)) {
            writeStarted = true;
            const tx = await state.campaign.processRefunds(10);
            transaction = tx.hash;
            const receipt = await tx.wait(1, 35000);
            if (!receipt || receipt.status !== 1) return { ready: false, error: 'transaction_unconfirmed' };
            // Return to the same range until its refund queues are drained.
            await db.send(new PutCommand({ TableName, Item: { pk, cursor } }));
            return { ready: true, refunded: true, transaction };
          }
        }
      }
      await db.send(new PutCommand({ TableName, Item: { pk, cursor: (cursor + 10) % count } }));
      return { ready: true, scanned: Math.min(10, count - cursor), ...(transaction ? { transaction } : {}) };
      } catch {
        // Never resubmit through another provider after a possibly accepted write.
        if (writeStarted) {
          await db.send(new PutCommand({ TableName, Item: { pk, cursor: Number(record?.cursor || 0) + 1 } }));
          return { ready: false, error: 'transaction_unconfirmed' };
        }
      }
    }
    return { ready: false, error: 'chain_unavailable' };
  } catch { return { ready: false, error: 'finalizer_unavailable' }; }
};

exports.handler = async () => {
  const result = await run();
  console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'MarketplaceProtected', Dimensions: [['Service']], Metrics: [{ Name: 'Failures', Unit: 'Count' }] }] },
    Service: process.env.AWS_LAMBDA_FUNCTION_NAME || 'protected-finalizer', Failures: result.ready ? 0 : 1,
    outcome: result.error || (result.finalized ? 'finalized' : result.refunded ? 'refunded' : 'checked'),
  }));
  return result;
};
