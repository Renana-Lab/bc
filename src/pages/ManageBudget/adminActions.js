// Admin Zone write actions. Each one is a plain contract call that the factory enforces with onlyAdmin /
// onlyOwner; the UI gate is only a convenience. Nothing here reads or sends auction payloads.
import factoryContract from "../../real_ethereum/factory";
import campaignContract from "../../real_ethereum/campaign";
import { requireWalletAccess } from "../../real_ethereum/walletAccess";

export const MAX_NOTE_BYTES = 500;
export const MAX_MINIMUM = 1_000_000_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const defaultDeps = () => ({
  factory: factoryContract,
  campaign: campaignContract,
  requestAccount: async () => (await requireWalletAccess()).account,
});

const requireAddress = (value, label) => {
  const text = String(value ?? "").trim();
  if (!ADDRESS.test(text)) throw new Error(`${label} must be a valid address.`);
  return text;
};

const wholeNumber = (value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a whole number.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return text;
};

export const byteLength = (text) => new TextEncoder().encode(String(text ?? "")).length;

export const validateMinimum = (value) => wholeNumber(value, "Minimum", { min: 1, max: MAX_MINIMUM });
export const validateBudgetTotal = (value) => wholeNumber(value, "Budget", { min: 0 });
export const validateGlobalBudget = (value) => wholeNumber(value, "Budget", { min: 1 });
export const validateNote = (note) => {
  const text = String(note ?? "").trim();
  if (byteLength(text) > MAX_NOTE_BYTES) throw new Error(`Note must be at most ${MAX_NOTE_BYTES} bytes.`);
  return text;
};

const send = async (deps, build) => {
  const from = await deps.requestAccount();
  return build(from).send({ from });
};

export const createAdminActions = (overrides = {}) => {
  const deps = { ...defaultDeps(), ...overrides };
  return {
    resetAllBudgets: (budget) => {
      const value = validateGlobalBudget(budget);
      return send(deps, () => deps.factory.methods.resetAllBudgets(value));
    },
    setUserBudget: (user, total) => {
      const address = requireAddress(user, "User");
      const value = validateBudgetTotal(total);
      return send(deps, () => deps.factory.methods.setUserBudget(address, value));
    },
    setMinimum: (campaign, minimum) => {
      const address = requireAddress(campaign, "Auction");
      const value = validateMinimum(minimum);
      return send(deps, () => deps.factory.methods.setMinimum(address, value));
    },
    sellerSetMinimum: (campaign, minimum) => {
      const address = requireAddress(campaign, "Auction");
      const value = validateMinimum(minimum);
      return send(deps, () => deps.campaign(address).methods.sellerSetMinimum(value));
    },
    closeNow: (campaign) => {
      const address = requireAddress(campaign, "Auction");
      return send(deps, () => deps.factory.methods.closeNow(address));
    },
    cancelAuction: (campaign, note) => {
      const address = requireAddress(campaign, "Auction");
      const text = validateNote(note);
      return send(deps, () => deps.factory.methods.cancelAuction(address, text));
    },
    setHidden: (campaign, hidden) => {
      const address = requireAddress(campaign, "Auction");
      return send(deps, () => deps.factory.methods.setHidden(address, Boolean(hidden)));
    },
    setDisabled: (user, disabled) => {
      const address = requireAddress(user, "User");
      return send(deps, () => deps.factory.methods.setDisabled(address, Boolean(disabled)));
    },
    setAllowSellerEdit: (allowed) =>
      send(deps, () => deps.factory.methods.setAllowSellerEdit(Boolean(allowed))),
    addAdmin: (admin) => {
      const address = requireAddress(admin, "Admin");
      return send(deps, () => deps.factory.methods.addAdmin(address));
    },
    removeAdmin: (admin) => {
      const address = requireAddress(admin, "Admin");
      return send(deps, () => deps.factory.methods.removeAdmin(address));
    },
  };
};

export default createAdminActions;
