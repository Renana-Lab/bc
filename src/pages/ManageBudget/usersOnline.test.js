import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("../../real_ethereum/readOnly", () => ({ readOnlyCall: jest.fn(), readOnlyExecute: jest.fn(), readOnlyBatchCall: jest.fn() }));
jest.mock("../../real_ethereum/socketFactory", () => ({ canUseLiveEvents: () => false, factorySocket: { events: {} } }));
jest.mock("../../real_ethereum/adminChain", () => ({
  readCancelledSet: jest.fn(async () => new Set()),
  readHiddenSet: jest.fn(async () => new Set()),
  readFactoryOwner: jest.fn(async () => "0xowner"),
  readIsFactoryAdmin: jest.fn(async () => true),
}));
jest.mock("../../real_ethereum/factory", () => ({ __esModule: true, default: {} }));
jest.mock("../../real_ethereum/campaign", () => ({ __esModule: true, default: () => ({}) }));
jest.mock("../../real_ethereum/walletAccess", () => ({
  requireWalletAccess: async () => ({ account: "0xabc" }),
  getWalletAccess: () => ({ status: "disconnected" }),
  subscribeWalletAccess: () => () => {},
}));
jest.mock("../../telemetry/presenceClient", () => ({ getLivePresence: jest.fn(), isPresenceConfigured: () => false }));
jest.mock("./adminAuditReader", () => ({ ...jest.requireActual("./adminAuditReader"), getAuditSnapshot: jest.fn() }));
jest.mock("../../real_ethereum/wallets/sweepClient.mjs", () => ({ fetchSweeps: jest.fn(), saveSweepIdleMinutes: jest.fn() }));
jest.mock("./participantsGasReaders", () => ({ readNativeBalances: jest.fn(), readBudgets: jest.fn(), readParticipantSources: jest.fn() }));
jest.mock("./adminTransfer", () => ({ sendNativeFromAdmin: jest.fn(), waitForReceipt: jest.fn(), readAdminBalance: jest.fn(), explorerTxUrl: (hash) => hash }));

/* eslint-disable import/first */
import { readFactoryOwner, readIsFactoryAdmin } from "../../real_ethereum/adminChain";
import { readOnlyCall, readOnlyBatchCall } from "../../real_ethereum/readOnly";
import { getAuditSnapshot } from "./adminAuditReader";
import { fetchSweeps } from "../../real_ethereum/wallets/sweepClient.mjs";
import { setSessionPassword, clearSessionPassword } from "./faucetSessionPassword";
import { resetSweepsCache } from "./faucetSweepsCache";
import { UsersBudgetsCard } from "./AdminOpsCards";
import { ParticipantsGasCardBody } from "./ParticipantsGasCard";
/* eslint-enable import/first */

const a = (n) => `0x${String(n).repeat(40)}`;
const USER = a(1);
const SELLER = a(2);
const SWEEP_ONLY = a(3);
const BASE = Date.parse("2026-01-01T12:00:00Z");
const iso = (minutesAgo) => new Date(BASE - minutesAgo * 60_000).toISOString();

const mockChain = ({ users = [USER] } = {}) =>
  readOnlyCall.mockImplementation(async (fn) => {
    const spec = fn({ factory: { methods: new Proxy({}, { get: (_, method) => (...args) => ({ method, args }) }) } });
    if (spec.method === "allUsers") {
      if (spec.args[0] < users.length) return users[spec.args[0]];
      throw new Error("execution reverted");
    }
    if (spec.method === "getBudget") return "777";
    if (spec.method === "heldBy") return "0";
    if (spec.method === "disabled") return false;
    return null;
  });

const created = (seller) => ({ name: "AuctionCreatedDetailed", actor: seller.toLowerCase(), blockNumber: 5, args: { seller, campaignAddress: a(9) } });
const mockAudit = (events = []) => getAuditSnapshot.mockResolvedValue({ events, latest: 10, lookback: 1000, failedRanges: [] });
const mockSweeps = (sweeps) => fetchSweeps.mockResolvedValue({ idleMinutes: 30, sweeps });

const openCard = () => fireEvent.click(screen.getByRole("button", { name: /Expand Users and budgets/i }));
const rowCount = () => document.querySelectorAll("tbody tr").length;

beforeEach(() => {
  process.env.REACT_APP_FAUCET_URL = "https://faucet.test";
  setSessionPassword("pw");
  resetSweepsCache();
  jest.clearAllMocks();
  readFactoryOwner.mockResolvedValue("0xowner");
  readIsFactoryAdmin.mockResolvedValue(false);
  mockChain();
  mockAudit();
  mockSweeps([]);
});
afterEach(() => {
  clearSessionPassword();
  delete process.env.REACT_APP_FAUCET_URL;
  jest.useRealTimers();
});

describe("Users and budgets: every participant", () => {
  test("a seller only in AuctionCreatedDetailed appears with the getBudget value and a 'not registered yet' note", async () => {
    mockAudit([created(SELLER)]);
    render(<UsersBudgetsCard canWrite actions={{ setUserBudget: jest.fn(), setDisabled: jest.fn() }} />);
    openCard();
    await waitFor(() => expect(rowCount()).toBe(2));
    const row = screen.getByTitle(SELLER).closest("tr");
    expect(within(row).getAllByText("777").length).toBeGreaterThan(0);
    expect(within(row).getByText("not registered yet")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Set budget" })).toBeEnabled();
    expect(within(screen.getByTitle(USER).closest("tr")).queryByText("not registered yet")).toBeNull();
  });

  test("an address only in /admin/sweeps appears", async () => {
    mockSweeps([{ address: SWEEP_ONLY, lastSeen: iso(1), status: "armed" }]);
    render(<UsersBudgetsCard />);
    openCard();
    await waitFor(() => expect(screen.getByTitle(SWEEP_ONLY)).toBeInTheDocument());
    expect(screen.getByTitle(USER)).toBeInTheDocument();
  });

  test("no duplicates across allUsers, audit events and sweeps (case-insensitive)", async () => {
    jest.useFakeTimers("modern");
    jest.setSystemTime(BASE);
    mockAudit([created(USER.toUpperCase().replace("0X", "0x")), created(SELLER)]);
    mockSweeps([{ address: USER, lastSeen: iso(1) }, { address: SELLER.toUpperCase().replace("0X", "0x"), lastSeen: iso(2) }, { address: SWEEP_ONLY, lastSeen: iso(3) }]);
    render(<UsersBudgetsCard />);
    openCard();
    await waitFor(() => expect(rowCount()).toBe(3));
    expect(screen.getByText("Online now: 3")).toBeInTheDocument();
  });
});

describe("admin wallets", () => {
  const ADMIN = a(4);
  const byEvent = (name, by) => ({ name, actor: by.toLowerCase(), blockNumber: 6, args: { by, campaign: a(9) } });

  test("an event whose actor is only args.by adds no row", async () => {
    mockAudit([byEvent("AuctionCancelled", ADMIN), byEvent("MinimumChanged", ADMIN)]);
    render(<UsersBudgetsCard canWrite actions={{ setUserBudget: jest.fn(), setDisabled: jest.fn() }} />);
    openCard();
    await waitFor(() => expect(screen.getByTitle(USER)).toBeInTheDocument());
    expect(screen.queryByTitle(ADMIN)).toBeNull();
    expect(rowCount()).toBe(1);
  });

  test("a seller who is also an admin keeps the row and gets an admin chip", async () => {
    mockAudit([created(SELLER), byEvent("AuctionCancelled", SELLER)]);
    render(<UsersBudgetsCard canWrite actions={{ setUserBudget: jest.fn(), setDisabled: jest.fn() }} />);
    openCard();
    const row = (await screen.findByTitle(SELLER)).closest("tr");
    expect(within(row).getByText("admin")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Set budget" })).toBeEnabled();
    expect(within(screen.getByTitle(USER).closest("tr")).queryByText("admin")).toBeNull();
  });

  test("Online now ignores admin-only addresses", async () => {
    jest.useFakeTimers("modern");
    jest.setSystemTime(BASE);
    readFactoryOwner.mockResolvedValue(ADMIN);
    mockSweeps([{ address: ADMIN, lastSeen: iso(1) }, { address: USER, lastSeen: iso(1) }]);
    render(<UsersBudgetsCard canWrite actions={{ setUserBudget: jest.fn(), setDisabled: jest.fn() }} />);
    openCard();
    const row = (await screen.findByTitle(ADMIN)).closest("tr");
    expect(within(row).getByText("admin")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Set budget" })).toBeDisabled();
    expect(screen.getByText("Online now: 1")).toBeInTheDocument();
  });
});

describe("Online / last seen", () => {
  const renderWithSeen = async (minutesAgo) => {
    jest.useFakeTimers("modern");
    jest.setSystemTime(BASE);
    mockSweeps([{ address: USER, lastSeen: iso(minutesAgo), status: "armed" }]);
    render(<UsersBudgetsCard />);
    openCard();
    return screen.findByTestId("last-seen");
  };

  test("Online chip at 4 minutes, with a relative time and the ISO time in a tooltip", async () => {
    const cell = await renderWithSeen(4);
    await waitFor(() => expect(within(cell).getByText("4 min ago")).toBeInTheDocument());
    expect(within(cell).getByText("Online")).toBeInTheDocument();
    expect(within(cell).getByTitle(iso(4))).toBeInTheDocument();
    expect(screen.getByText("Online now: 1")).toBeInTheDocument();
  });

  test("no Online chip at 6 minutes", async () => {
    const cell = await renderWithSeen(6);
    await waitFor(() => expect(within(cell).getByText("6 min ago")).toBeInTheDocument());
    expect(within(cell).queryByText("Online")).toBeNull();
    expect(screen.getByText("Online now: 0")).toBeInTheDocument();
  });

  test("a participant without a sweep record shows '-'", async () => {
    mockSweeps([{ address: SELLER, lastSeen: iso(1) }]);
    render(<UsersBudgetsCard />);
    openCard();
    await waitFor(() => expect(rowCount()).toBe(2));
    expect(within(screen.getByTitle(USER).closest("tr")).getByTestId("last-seen")).toHaveTextContent("-");
  });

  test("when /admin/sweeps fails the rows stay and one muted line shows", async () => {
    fetchSweeps.mockRejectedValue(Object.assign(new Error("Wrong password."), { code: "unauthorized" }));
    render(<UsersBudgetsCard />);
    openCard();
    await waitFor(() => expect(screen.getByTitle(USER)).toBeInTheDocument());
    expect(await screen.findAllByText("Online status unavailable")).toHaveLength(1);
    expect(screen.getAllByText("777").length).toBeGreaterThan(0);
  });
});

test("Participants gas and Users and budgets share one /admin/sweeps request", async () => {
  const deps = {
    readSources: jest.fn(async () => ({ users: [USER], events: [], latestBlock: 1, warning: "" })),
    readBalances: jest.fn(async () => ({})),
    readBudgets: jest.fn(async () => ({})),
  };
  render(<ParticipantsGasCardBody adminAccount={a("e")} defaultOpen deps={deps} />);
  fireEvent.click(screen.getByRole("button", { name: "Load auto-return" }));
  await waitFor(() => expect(fetchSweeps).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  render(<UsersBudgetsCard />);
  fireEvent.click(screen.getByRole("button", { name: /Expand Users and budgets/i }));
  await waitFor(() => expect(screen.getByTitle(USER)).toBeInTheDocument());
  expect(fetchSweeps).toHaveBeenCalledTimes(1);
});

describe("Participants gas budget reader", () => {
  const { readBudgets: realReadBudgets } = jest.requireActual("./participantsGasReaders");
  test("uses getBudget, not the raw usersBudget mapping", async () => {
    readOnlyBatchCall.mockImplementation(async (build) => {
      const factory = { methods: new Proxy({}, { get: (_, method) => () => ({ call: { request: () => method } }) }) };
      return build({ factory }).map((spec) => ({ status: "fulfilled", value: spec.request() === "getBudget" ? "1000" : "0" }));
    });
    expect(await realReadBudgets([USER])).toEqual({ [USER]: "1000" });
  });
  test("a failed read stays 'unavailable'", async () => {
    readOnlyBatchCall.mockRejectedValue(new Error("rpc down"));
    expect(await realReadBudgets([USER])).toEqual({ [USER]: "unavailable" });
  });
});
