const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const appId = 'd1n93p6nqw0kho';
const branch = 'main';
const root = path.resolve(__dirname, '../..');
const build = path.join(root, 'artifacts/backend/protected/build');
const zip = path.join(root, 'artifacts/backend/protected/frontend.zip');
const aws = args => execFileSync('aws', [...args, '--profile', 'presence-deploy', '--region', 'us-east-2', '--no-cli-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function main() {
  if (!fs.existsSync(path.join(build, 'index.html'))) throw new Error('Protected production build is required');
  const sourceBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', cwd: root }).trim();
  if (sourceBranch !== 'marketplace-protected') throw new Error('Deployment is restricted to the protected branch');
  const environment = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
  const secrets = Object.entries(environment).filter(([key, value]) => /PRIVATE_KEY|MNEMONIC|SECRET|INFURA_KEY/.test(key) && value.length > 12).map(([, value]) => value);
  const scan = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(js|html|json|css)$/.test(file)) {
        const content = fs.readFileSync(file, 'utf8');
        if (secrets.some(secret => content.includes(secret))) throw new Error('A server secret was found in the frontend build');
      }
    }
  };
  scan(build);
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Compress-Archive -Path ${quote(path.join(build, '*'))} -DestinationPath ${quote(zip)} -Force`], { stdio: 'pipe' });
  const deployment = JSON.parse(aws(['amplify', 'create-deployment', '--app-id', appId, '--branch-name', branch, '--output', 'json']));
  const response = await fetch(deployment.zipUploadUrl, { method: 'PUT', body: fs.readFileSync(zip) });
  if (!response.ok) throw new Error('Amplify upload failed');
  const result = JSON.parse(aws(['amplify', 'start-deployment', '--app-id', appId, '--branch-name', branch, '--job-id', deployment.jobId, '--output', 'json']));
  fs.writeFileSync(path.join(root, 'artifacts/backend/protected/frontend-deployment.json'), JSON.stringify({ appId, branch, jobId: deployment.jobId, status: result.jobSummary.status, url: `https://${branch}.${appId}.amplifyapp.com` }, null, 2));
  console.log(JSON.stringify({ appId, branch, jobId: deployment.jobId, status: result.jobSummary.status }));
}
main().catch(() => { console.error('Protected frontend deployment failed. No secret or signed upload URL was logged.'); process.exitCode = 1; });
