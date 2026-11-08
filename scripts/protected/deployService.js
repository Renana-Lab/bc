'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const template = require('../../infrastructure/protected/template');
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Arguments require --name value');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
function deploy(options) {
  const factory = options.factory;
  if (!/^0x[\da-f]{40}$/i.test(factory || '') || /^0x0{40}$/i.test(factory)) throw new Error('--factory requires deployed protected factory');
  if (!options.origins || options.origins.split(',').some(x => !/^https:\/\/[\w.-]+(?::\d+)?$/.test(x) && !/^http:\/\/localhost:\d+$/.test(x))) throw new Error('--origins requires exact HTTPS origins or localhost development origins');
  if (!options['rpc-secret-arn'] && !options['rpc-url']) throw new Error('Provide --rpc-secret-arn (recommended) or --rpc-url');
  if (options['rpc-url'] && options['rpc-url'].split(',').some(x => { const u = new URL(x); return u.protocol !== 'https:' || u.username || u.password || u.search || !['', '/'].includes(u.pathname); })) throw new Error('Use Secrets Manager for credential-bearing RPC URLs');
  const region = options.region || 'us-east-1';
  const stack = options['stack-name'] || 'marketplace-protected';
  if (!/^[A-Za-z][A-Za-z0-9-]{0,80}$/.test(stack) || stack === 'bc-live-presence') throw new Error('Invalid isolated stack name');
  const profile = options.profile || 'presence-deploy';
  const aws = argv => execFileSync('aws', [...argv, '--region', region, '--profile', profile, '--no-cli-pager'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-protected-'));
  const source = path.resolve(__dirname, '../../infrastructure/protected');
  const code = path.join(dir, 'code'); fs.mkdirSync(code);
  for (const name of ['index.js', 'service.js', 'finalizer.js', 'archive.js', 'pagination.js', 'package.json']) fs.copyFileSync(path.join(source, name), path.join(code, name));
  // Isolated package install: never change the shared application's dependencies.
  if (process.platform === 'win32') execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm install --omit=dev --ignore-scripts --no-audit --no-fund'], { cwd: code, stdio: 'pipe' });
  else execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: code, stdio: 'pipe' });
  const zip = path.join(dir, 'function.zip');
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${code.replace(/'/g, "''")}\\*' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`], { stdio: 'pipe' });
  } else execFileSync('zip', ['-qr', zip, '.'], { cwd: code, stdio: 'pipe' });
  if (fs.statSync(zip).size > 49 * 1024 * 1024) throw new Error('Lambda zip too large for direct upload');
  const file = path.join(dir, 'template.json'); fs.writeFileSync(file, JSON.stringify(template()));
  const overrides = [`Factory=${factory}`, `Origins=${options.origins}`, `ChainId=${options['chain-id'] || 11155111}`, `RpcUrl=${options['rpc-url'] || ''}`, `RpcSecretArn=${options['rpc-secret-arn'] || ''}`, `LegacyFactories=${options['legacy-factories'] || ''}`, `FinalizerSecretArn=${options['finalizer-secret-arn'] || ''}`];
  aws(['cloudformation', 'deploy', '--template-file', file, '--stack-name', stack, '--capabilities', 'CAPABILITY_IAM', '--parameter-overrides', ...overrides, '--no-fail-on-empty-changeset']);
  // Parse structured output instead of shell-interpreted JMESPath pipes on Windows.
  const data = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--output', 'json']));
  const outputs = Object.fromEntries(data.Stacks[0].Outputs.map(x => [x.OutputKey, x.OutputValue]));
  for (const name of [outputs.FunctionName, outputs.FinalizerFunctionName].filter(Boolean)) {
    aws(['lambda', 'update-function-code', '--function-name', name, '--zip-file', 'fileb://' + zip]);
    aws(['lambda', 'wait', 'function-updated', '--function-name', name]);
  }
  return { ...outputs, finalizerConfigured: !!options['finalizer-secret-arn'], artifactDirectory: dir };
}
if (require.main === module) {
  try { console.log(JSON.stringify(deploy(args(process.argv.slice(2))), null, 2)); }
  catch { console.error('Protected service deployment failed. Inspect stack events; no credentials or command arguments are printed.'); process.exitCode = 1; }
}
module.exports = { args, deploy };
