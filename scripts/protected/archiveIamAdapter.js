const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);

function decodeInvocation(metadata, payload) {
  if (metadata.FunctionError) throw new Error('Administrative Lambda invocation failed');
  if (payload && Object.hasOwn(payload, 'statusCode')) {
    if (payload.statusCode < 200 || payload.statusCode >= 300) {
      let body;
      try { body = typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body; } catch (_) {}
      const known = new Set(['archive_chain_unavailable', 'archive_snapshot_mismatch', 'archive_content_mismatch', 'archive_envelope_mismatch', 'archive_conflict', 'service_unavailable']);
      throw Object.assign(new Error('Administrative archive operation rejected'), { code: known.has(body?.error) ? body.error : 'archive_rejected' });
    }
    return typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body;
  }
  if (payload?.error) throw new Error('Administrative archive operation rejected');
  return payload;
}

async function createArchiveAdminAdapter({ identity, profile, region }) {
  const functionName = process.env.PROTECTED_SERVICE_FUNCTION;
  if (!functionName || !/^(?:[a-zA-Z0-9-_]+(?::[a-zA-Z0-9-_]+)?|arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9-_]+(?::[a-zA-Z0-9-_]+)?)$/.test(functionName)) {
    throw new Error('PROTECTED_SERVICE_FUNCTION must name the IAM-protected Lambda');
  }
  if (functionName.startsWith('arn:') && functionName.split(':')[4] !== identity.Account) {
    throw new Error('Administrative Lambda belongs to another AWS account');
  }
  const invoke = async (event) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-archive-'));
    const request = path.join(directory, 'request.json');
    const response = path.join(directory, 'response.json');
    try {
      fs.writeFileSync(request, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
      const args = ['lambda', 'invoke', '--function-name', functionName, '--region', region,
        '--payload', `fileb://${request}`, '--output', 'json', '--no-cli-pager', response];
      if (profile) args.push('--profile', profile);
      for (let attempt = 0; ; attempt++) {
        try {
          const { stdout } = await execute('aws', args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
          return decodeInvocation(JSON.parse(stdout), JSON.parse(fs.readFileSync(response, 'utf8')));
        } catch (error) {
          if (attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    } catch (error) {
      throw Object.assign(new Error('IAM administrative archive operation failed'), { code: error.code || 'archive_transport' });
    } finally {
      // Fixed known files only; no recursive deletion of computed directories.
      for (const file of [request, response]) if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.rmdirSync(directory);
    }
  };
  return {
    authKind: 'aws-iam',
    getEncryptionConfig: async () => invoke({ adminAction: 'config' }),
    lookupArchive: async (archiveId) => invoke({ adminAction: 'lookup', archiveId }),
    lookupArchives: async (archiveIds) => invoke({ adminAction: 'lookup-many', archiveIds }),
    importArchive: async (body) => invoke({ adminAction: 'import', body }),
  };
}

module.exports = { createArchiveAdminAdapter, decodeInvocation };
