const fs = require('node:fs');
const path = require('node:path');
const {
  MarketStore
} = require('./store');
(async () => {
  const dir = path.resolve(process.env.MARKET_DATA_DIR || 'market-data');
  fs.mkdirSync(dir, {
    recursive: true
  });
  const store = new MarketStore(path.join(dir, 'market.sqlite'));
  try {
    const flag = process.argv.includes('--identifier') ? '--identifier' : '--email';
    const identifier = process.argv[process.argv.indexOf(flag) + 1];
    if (!process.argv.includes(flag)) throw new Error('Usage: npm run market:create-admin -- --identifier research-admin');
    await store.createUser({
      name: 'Administrator',
      identifier,
      role: 'admin'
    }, null, true);
    console.log(`Administrator created: ${identifier}\nSign in using this identifier. No password is required.`);
  } finally {
    store.close();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
