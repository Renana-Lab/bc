const path = require('node:path');
const fs = require('node:fs');
const {
  MarketStore
} = require('./store');
const dir = path.resolve(process.env.MARKET_DATA_DIR || 'market-data');
const source = path.join(dir, 'market.sqlite');
if (!fs.existsSync(source)) throw new Error('No marketplace database found');
const destination = path.join(dir, `backup-${Date.now()}.sqlite`);
const store = new MarketStore(source);
try {
  // SQLite includes committed WAL data in a consistent online snapshot.
  store.run('VACUUM INTO ?', destination);
  console.log(`Backup created: ${destination}`);
} finally {
  store.close();
}
