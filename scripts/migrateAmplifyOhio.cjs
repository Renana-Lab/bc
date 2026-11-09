const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = 'us-east-1';
const target = 'us-east-2';
const aws = (region, ...args) => JSON.parse(execFileSync('aws', [...args, '--profile', 'presence-deploy', '--region', region, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

async function main() {
  const apps = aws(target, 'amplify', 'list-apps').apps;
  for (const [id, jobId] of [['d1480nbd1jz398', '25'], ['df7mlebpdd7v7', '8']]) {
    const { app } = aws(source, 'amplify', 'get-app', '--app-id', id);
    const { job } = aws(source, 'amplify', 'get-job', '--app-id', id, '--branch-name', 'main', '--job-id', jobId);
    if (app.repository || app.enableBasicAuth || job.summary.status !== 'SUCCEED') throw Error('Source is not a successful manual deployment');
    const artifact = job.steps.find(s => s.stepName === 'DEPLOY')?.artifactsUrl;
    if (!artifact) throw Error('No source artifact');
    const response = await fetch(artifact, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Artifact unavailable (${response.status})`);
    const zip = Buffer.from(await response.arrayBuffer());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amplify-ohio-'));
    const file = path.join(dir, 'deploy.zip');
    try {
      fs.writeFileSync(file, zip);
      const files = execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).split(/\r?\n/);
      if (!files.some(f => /^(\.\/)?index\.html$/.test(f))) throw Error('Source archive does not have a root index.html');
    } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(dir); }
    const matches = apps.filter(a => a.name === app.name);
    if (matches.length > 1 || matches[0]?.repository) throw Error('Ambiguous Ohio destination');
    if (matches[0] && aws(target, 'amplify', 'list-branches', '--app-id', matches[0].appId).branches.some(b => b.branchName === 'main')) {
      const jobs = aws(target, 'amplify', 'list-jobs', '--app-id', matches[0].appId, '--branch-name', 'main').jobSummaries;
      if (jobs.some(j => ['SUCCEED', 'RUNNING', 'PENDING', 'PROVISIONING'].includes(j.status))) {
        console.log(JSON.stringify({ name: app.name, appId: matches[0].appId, skippedExisting: true }));
        continue;
      }
    }
    const appId = matches[0]?.appId || aws(target, 'amplify', 'create-app', '--name', app.name, '--platform', 'WEB', '--custom-rules', JSON.stringify(app.customRules || [])).app.appId;
    if (!aws(target, 'amplify', 'list-branches', '--app-id', appId).branches.some(b => b.branchName === 'main')) {
      aws(target, 'amplify', 'create-branch', '--app-id', appId, '--branch-name', 'main', '--stage', 'PRODUCTION', '--no-enable-auto-build');
    }
    const args = ['--app-id', appId, '--branch-name', 'main'];
    const deploy = aws(target, 'amplify', 'create-deployment', ...args);
    const upload = await fetch(deploy.zipUploadUrl, { method: 'PUT', body: zip, signal: AbortSignal.timeout(60000) });
    if (!upload.ok) throw Error(`Ohio upload failed (${upload.status})`);
    aws(target, 'amplify', 'start-deployment', ...args, '--job-id', deploy.jobId);
    console.log(JSON.stringify({ name: app.name, appId, jobId: deploy.jobId, url: `https://main.${appId}.amplifyapp.com`, sourceJob: jobId }));
  }
}
main().catch(error => { console.error(error.status ? 'AWS operation failed' : error.message); process.exitCode = 1; });
