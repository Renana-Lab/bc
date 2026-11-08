const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const directory = fs.realpathSync(path.resolve(process.argv[2] || ''));
const temporaryRoot = fs.statSync(os.tmpdir());
const parentDirectory = fs.statSync(path.dirname(directory));
if (process.platform !== 'win32' || temporaryRoot.dev !== parentDirectory.dev || temporaryRoot.ino !== parentDirectory.ino || !path.basename(directory).startsWith('marketplace-protected-')) throw new Error('Expected existing protected packaging directory');
const zip = path.join(directory, 'function.zip');
if (!fs.existsSync(zip)) throw new Error('Existing deployment archive required');
const source = path.resolve(__dirname, '../../infrastructure/protected');
const quote = value => `'${value.replace(/'/g, "''")}'`;
const files = ['index.js', 'service.js', 'archive.js', 'finalizer.js', 'pagination.js'];
const commands = ["$ErrorActionPreference='Stop'", 'Add-Type -AssemblyName System.IO.Compression', 'Add-Type -AssemblyName System.IO.Compression.FileSystem', `$z=[System.IO.Compression.ZipFile]::Open(${quote(zip)},[System.IO.Compression.ZipArchiveMode]::Update)`, 'try {'];
for (const file of files) commands.push(`$e=$z.GetEntry(${quote(file)}); if($e){$e.Delete()}; [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,${quote(path.join(source, file))},${quote(file)},[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null`);
commands.push('} finally { $z.Dispose() }');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', commands.join('\n')], { stdio: 'pipe' });
for (const name of ['marketplace-protected-service', 'marketplace-protected-finalizer']) {
  execFileSync('aws', ['lambda', 'update-function-code', '--function-name', name, '--zip-file', 'fileb://' + zip, '--profile', 'presence-deploy', '--region', 'us-east-1', '--no-cli-pager'], { stdio: 'pipe' });
  execFileSync('aws', ['lambda', 'wait', 'function-updated', '--function-name', name, '--profile', 'presence-deploy', '--region', 'us-east-1'], { stdio: 'pipe' });
}
console.log('Updated isolated protected service and finalizer code.');
