// Batched chain reads for the Users and budgets card, Participants gas and the reports. Everything goes through
// readOnlyBatchCall (25 requests per JSON-RPC batch) and the shared RPC lane, never one request per address and field.
import { readOnlyBatchCall, readOnlyCall } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { readFactoryUsers } from "./adminAuditReader";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const BATCH = 25;
const lower = (value) => String(value ?? "").toLowerCase();

const optionsFor = (factoryAddress = getActiveFactoryAddress()) => ({ ...READ_OPTIONS, factoryAddress });

// allUsersCount() + batched allUsers(i). Falls back to the probe-until-revert when the count is unavailable.
export const readUsersList = ({ factoryAddress, call = readOnlyCall, batchCall = readOnlyBatchCall } = {}) => {
  const options = optionsFor(factoryAddress);
  return readFactoryUsers({
    readCount: () => call(({ factory }) => factory.methods.allUsersCount(), 1, options),
    readIndex: (index) => call(({ factory }) => factory.methods.allUsers(index), 1, options),
    readBatch: (indexes) => batchCall(
      ({ factory }) => indexes.map((index) => ({ request: (callback) => factory.methods.allUsers(index).call.request({}, callback) })),
      undefined, options,
    ),
  });
};

// One batched pass for per-address state: getBudget (applies a pending global reset), heldBy, disabled and isAdmin, plus
// the factory owner once. Resolves { budgets, held, disabled:Set, admins:Set, owner, budgetErrors }. A failed
// budget/held/disabled read makes that address "unavailable"; a failed isAdmin / owner read only means "no admin flag".
export const readUserStates = async (addresses, { factoryAddress, withOwner = false, batchCall = readOnlyBatchCall } = {}) => {
  const options = optionsFor(factoryAddress);
  const calls = [];
  if (withOwner) calls.push({ kind: "owner", build: (factory) => factory.methods.owner() });
  addresses.forEach((address) => {
    calls.push({ kind: "budget", address, build: (factory) => factory.methods.getBudget(address) });
    calls.push({ kind: "held", address, build: (factory) => factory.methods.heldBy(address) });
    calls.push({ kind: "disabled", address, build: (factory) => factory.methods.disabled(address) });
    calls.push({ kind: "admin", address, build: (factory) => factory.methods.isAdmin(address) });
  });
  const out = { budgets: {}, held: {}, disabled: new Set(), admins: new Set(), owner: "", budgetErrors: 0 };
  const failed = new Set();
  const values = {};
  for (let start = 0; start < calls.length; start += BATCH) {
    const chunk = calls.slice(start, start + BATCH);
    let results;
    try {
      results = await batchCall(
        ({ factory }) => chunk.map((item) => ({ request: (callback) => item.build(factory).call.request({}, callback) })),
        undefined, options,
      );
    } catch (_) {
      results = chunk.map(() => ({ status: "rejected" }));
    }
    chunk.forEach((item, index) => {
      const key = `${item.kind}:${lower(item.address)}`;
      if (results[index]?.status === "fulfilled") values[key] = results[index].value;
      else if (item.kind === "budget" || item.kind === "held" || item.kind === "disabled") failed.add(lower(item.address));
    });
  }
  if (withOwner && values["owner:"]) out.owner = lower(values["owner:"]);
  addresses.forEach((address) => {
    const key = lower(address);
    if (failed.has(key)) { out.budgets[key] = "unavailable"; out.budgetErrors += 1; return; }
    out.budgets[key] = String(values[`budget:${key}`]);
    out.held[key] = String(values[`held:${key}`]);
    if (values[`disabled:${key}`] === true || values[`disabled:${key}`] === "true") out.disabled.add(key);
    if (values[`admin:${key}`] === true || values[`admin:${key}`] === "true") out.admins.add(key);
  });
  return out;
};
