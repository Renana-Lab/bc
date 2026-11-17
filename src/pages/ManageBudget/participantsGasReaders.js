// Network readers for the Participants gas card. Reads are batched (25 addresses per JSON-RPC batch) and go through
// readOnlyExecute, i.e. through the shared RPC lanes/rate limiter, never one request per address.
import { readOnlyBatchCall, readOnlyExecute } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { getAuditSnapshot } from "./adminAuditReader";
import { readUsersList } from "./usersChainReaders";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const BATCH = 25;

// Resolves { [lowercase address]: bigint | null }. A failed read is null (shown as "—"), never zero.
export const readNativeBalances = async (addresses, { execute = readOnlyExecute } = {}) => {
  const balances = {};
  for (let start = 0; start < addresses.length; start += BATCH) {
    const chunk = addresses.slice(start, start + BATCH);
    let results;
    try {
      results = await execute(({ web3 }) => new Promise((resolve, reject) => {
        const batch = new web3.BatchRequest();
        const out = new Array(chunk.length).fill(null);
        let remaining = chunk.length;
        chunk.forEach((address, index) => {
          batch.add(web3.eth.getBalance.request(address, "latest", (error, value) => {
            out[index] = error ? null : BigInt(value);
            remaining -= 1;
            if (remaining === 0) resolve(out);
          }));
        });
        try { batch.execute(); } catch (error) { reject(error); }
      }), undefined, READ_OPTIONS);
    } catch {
      results = new Array(chunk.length).fill(null);
    }
    chunk.forEach((address, index) => { balances[address.toLowerCase()] = results[index]; });
  }
  return balances;
};

// getBudget (not the raw usersBudget mapping): it is non-zero for unregistered users and applies a pending global reset.
export const readBudgets = async (addresses) => {
  const factoryAddress = getActiveFactoryAddress();
  const out = {};
  for (let start = 0; start < addresses.length; start += BATCH) {
    const chunk = addresses.slice(start, start + BATCH);
    try {
      const results = await readOnlyBatchCall(
        ({ factory }) => chunk.map((address) => ({ request: (callback) => factory.methods.getBudget(address).call.request({}, callback) })),
        undefined, { ...READ_OPTIONS, factoryAddress },
      );
      chunk.forEach((address, index) => { out[address.toLowerCase()] = results[index]?.status === "fulfilled" ? String(results[index].value) : "unavailable"; });
    } catch {
      chunk.forEach((address) => { out[address.toLowerCase()] = "unavailable"; });
    }
  }
  return out;
};

// factory.allUsers + the shared audit snapshot (bidders / sellers with their latest block).
export const readParticipantSources = async ({ force = false } = {}) => {
  const factoryAddress = getActiveFactoryAddress();
  const users = await readUsersList({ factoryAddress });
  let audit = null;
  try { audit = await getAuditSnapshot(factoryAddress, { force }); } catch { audit = null; }
  return { users: users.addresses, events: audit?.events || [], latestBlock: audit?.latest ?? null, warning: users.warning };
};
