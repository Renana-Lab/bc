const {
  spawn
} = require('node:child_process');
const path = require('node:path');
const api = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MARKET_DEV_LOGIN: '1',
    MARKET_ADMIN_PASSWORD: process.env.MARKET_ADMIN_PASSWORD || 'local-admin',
    MARKET_ORIGIN: 'http://localhost:3010'
  }
});
const ui = spawn(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--mode', 'backend', '--port', '3010', '--strictPort'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BROWSER: 'none'
  }
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill();
  ui.kill();
  process.exitCode = code;
}
api.on('exit', code => stop(code));
ui.on('exit', code => stop(code));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
