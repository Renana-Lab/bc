const fs = require('node:fs');
const path = require('node:path');
const Web3 = require('web3');
const { compileContracts } = require('./compile');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

async function main() {
  const rpc = process.env.PROTECTED_RPC_URL || process.env.DEPLOY_RPC_URL || process.env.RPC_URL;
  if (!rpc) throw new Error('A Sepolia RPC endpoint is required');
  const web3 = new Web3(rpc);
  if (Number(await web3.eth.getChainId()) !== 11155111) throw new Error('Deployment is restricted to Sepolia');
  const key = process.env.DEPLOY_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.AUTO_FINALIZE_PRIVATE_KEY;
  if (!key) throw new Error('A deployment signing key is required');
  const account = web3.eth.accounts.privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  web3.eth.accounts.wallet.add(account);
  const artifact = compileContracts()['ProtectedCampaign.sol'].ProtectedCampaignFactory;
  const deploy = new web3.eth.Contract(artifact.abi).deploy({ data: `0x${artifact.evm.bytecode.object}` });
  const estimate = await deploy.estimateGas({ from: account.address });
  // Current Sepolia state-gas accounting differs from Shanghai local tests.
  // Verify the actual creation call rather than clamping to legacy gas limits.
  const gas = Math.ceil(Number(estimate) * 1.15);
  const block = await web3.eth.getBlock('latest');
  if (gas > 60000000 || gas >= Number(block.gasLimit)) throw new Error('Deployment gas exceeds the safety budget');
  await web3.eth.call({ from: account.address, data: deploy.encodeABI(), gas });
  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify({ dryRun: true, chainId: 11155111, from: account.address, estimatedGas: estimate, validatedGasLimit: gas }));
    return;
  }
  const directory = path.resolve(__dirname, '../../artifacts/backend/protected');
  const manifest = path.join(directory, 'factory-deployment.json');
  if (fs.existsSync(manifest)) throw new Error('A deployment manifest already exists; inspect it before deploying again');
  const contract = await deploy.send({ from: account.address, gas });
  const record = { chainId: 11155111, factory: contract.options.address, deployer: account.address, createdAt: new Date().toISOString(), compiler: require('solc').version() };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(record));
}
if (require.main === module) main().catch(() => { console.error('Protected factory deployment failed. Check network, signing credentials and existing deployment manifest.'); process.exitCode = 1; });
module.exports = { main };
