// Chain reads that feed the report tabs "Users and budget history" and "Audit events" and the cancelled flag used for
// the derived status. Failures are returned as warnings so a report is still produced.
import { readOnlyCall } from "../../real_ethereum/readOnly";
import { getActiveFactoryAddress } from "../../real_ethereum/marketConfig";
import { readCancelledSet } from "../../real_ethereum/adminChain";
import { getAuditSnapshot, readAllUsers } from "./adminAuditReader";
import { mapBotConfig } from "./adminCardData";
import { getAdminAddresses } from "./adminGate";
import { LOCAL_BOTS_KEY } from "../../telemetry/botPresence";
import { mapWithConcurrency, toAuditRows, toUserHistoryRows } from "./reportUtils";

const READ_OPTIONS = { preferInjected: false, allowInjectedFallback: false };
const lower = (value) => String(value ?? "").toLowerCase();

const readLocalBots = () => {
  try {
    return mapBotConfig(JSON.parse(window.localStorage.getItem(LOCAL_BOTS_KEY) || "[]"));
  } catch (_) {
    return mapBotConfig([]);
  }
};

// Admins now = allowlist + AdminAdded - AdminRemoved events inside the lookback.
export const adminSetFromEvents = (events = [], allowlist = []) => {
  const admins = new Set(allowlist.map(lower));
  [...events]
    .filter((event) => ["AdminAdded", "AdminRemoved"].includes(event.name))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .forEach((event) => {
      const who = lower(event.args.admin);
      if (event.name === "AdminAdded") admins.add(who);
      else admins.delete(who);
    });
  return admins;
};

export const loadReportChainData = async ({
  reports = [],
  wantUsers = false,
  wantAudit = false,
  wantStatus = false,
  factoryAddress = getActiveFactoryAddress(),
  deps = {},
} = {}) => {
  const api = { call: readOnlyCall, snapshot: getAuditSnapshot, cancelled: readCancelledSet, ...deps };
  const result = { userHistoryRows: [], auditRows: [], cancelledAddresses: [], warnings: [] };
  const options = { ...READ_OPTIONS, factoryAddress };

  let audit = null;
  if (wantUsers || wantAudit) {
    try {
      audit = await api.snapshot(factoryAddress, { force: true });
    } catch (error) {
      result.warnings.push(`Audit events unavailable: ${error?.message || "read failed"}`);
    }
  }
  if (wantAudit && audit) result.auditRows = toAuditRows(audit.events);

  if (wantUsers) {
    try {
      const users = await readAllUsers((index) => api.call(({ factory }) => factory.methods.allUsers(index), 1, options));
      if (users.warning) result.warnings.push(users.warning);
      const held = {};
      const budgets = {};
      const disabled = new Set();
      await mapWithConcurrency(users.addresses, 4, async (address) => {
        const key = lower(address);
        try {
          const [budget, heldAmount, isDisabled] = await Promise.all([
            api.call(({ factory }) => factory.methods.getBudget(address), 1, options),
            api.call(({ factory }) => factory.methods.heldBy(address), 1, options),
            api.call(({ factory }) => factory.methods.disabled(address), 1, options),
          ]);
          budgets[key] = String(budget);
          held[key] = String(heldAmount);
          if (isDisabled) disabled.add(key);
        } catch (_) {
          budgets[key] = "unavailable";
        }
      });
      const { labels, bots } = readLocalBots();
      result.userHistoryRows = toUserHistoryRows({
        addresses: users.addresses,
        budgets,
        held,
        disabled,
        events: audit?.events || [],
        labels,
        bots,
        admins: adminSetFromEvents(audit?.events || [], getAdminAddresses()),
      });
      if (!audit) result.warnings.push("Last budget changes unavailable (audit read failed).");
    } catch (error) {
      result.warnings.push(`Users unavailable: ${error?.message || "read failed"}`);
    }
  }

  if (wantStatus) {
    try {
      const closed = reports.filter(({ auction }) => auction.closed).map(({ auction }) => auction.address);
      if (closed.length) {
        const set = await api.cancelled(closed, { options });
        result.cancelledAddresses = Array.from(set);
      }
    } catch (error) {
      result.warnings.push(`Cancelled status unavailable: ${error?.message || "read failed"}`);
    }
  }
  return result;
};
