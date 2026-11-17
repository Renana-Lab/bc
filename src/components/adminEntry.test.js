import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DrawerComponent from "./Drawer";
import AdminLoginPage from "../pages/AdminWallet/AdminLoginPage";
import { ADMIN_HINT_KEY, forgetAdminDevice, hasAdminDeviceHint, rememberAdminDevice } from "./adminEntry";

const ADMIN = `0x${"e".repeat(40)}`;
const OTHER = `0x${"1".repeat(40)}`;
const mockAccess = { isAdmin: false, onAllowlist: false };
let mockLogin;
jest.mock("../pages/ManageBudget/useAdminAccess", () => ({ useAdminAccess: () => mockAccess }));
jest.mock("../pages/AdminWallet/adminLogin", () => ({
  connectAdminWithMetaMask: (...args) => mockLogin(...args),
  importAdminKey: (...args) => mockLogin(...args),
  readOnChainAdminRole: async () => true,
}));

const open = () => render(
  <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <DrawerComponent open toggleDrawerHandler={() => {}} />
  </MemoryRouter>,
);
const settle = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }); };
const ITEMS = ["-- Admin Zone --", "Admin sign-in", "Admin wallet"];
const expectNone = () => ITEMS.forEach((text) => expect(screen.queryByText(text)).toBeNull());

beforeEach(() => {
  process.env.REACT_APP_WALLET_MODE = "local";
  process.env.REACT_APP_ADMIN_ADDRESSES = ADMIN;
  mockAccess.isAdmin = false; mockAccess.onAllowlist = false;
  window.localStorage.clear(); window.sessionStorage.clear();
  delete window.ethereum;
});
afterEach(() => {
  delete process.env.REACT_APP_WALLET_MODE; delete process.env.REACT_APP_ADMIN_ADDRESSES;
  window.localStorage.clear(); window.sessionStorage.clear(); delete window.ethereum;
});

describe.each(["local", "metamask"])("a participant in %s mode", (mode) => {
  test("sees none of the admin items", async () => {
    process.env.REACT_APP_WALLET_MODE = mode;
    open(); await settle();
    expectNone();
  });
});

test("an allowlisted account in MetaMask mode sees the Admin Zone but no sign-in item", async () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  mockAccess.onAllowlist = true;
  open(); await settle();
  expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
  expect(screen.queryByText("Admin sign-in")).toBeNull();
});

describe("device hint (local mode)", () => {
  test("a hint for an allowlisted address shows the Admin Zone and the sign-in item", async () => {
    rememberAdminDevice(ADMIN);
    open(); await settle();
    expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
    expect(screen.getByText("Admin sign-in")).toBeTruthy();
    expect(screen.getByText("Admin wallet")).toBeTruthy();
  });

  test("a hint for a non-allowlisted address is ignored", async () => {
    window.localStorage.setItem(ADMIN_HINT_KEY, JSON.stringify({ address: OTHER, at: 1 }));
    open(); await settle();
    expectNone();
  });

  test("a hint stops working once the address leaves the allowlist; garbage is tolerated", () => {
    rememberAdminDevice(ADMIN);
    expect(hasAdminDeviceHint()).toBe(true);
    process.env.REACT_APP_ADMIN_ADDRESSES = OTHER;
    expect(hasAdminDeviceHint()).toBe(false);
    window.localStorage.setItem(ADMIN_HINT_KEY, "{not json");
    expect(hasAdminDeviceHint()).toBe(false);
  });

  test("only allowlisted addresses are remembered, lower-cased, address and time only; forget removes it", () => {
    rememberAdminDevice(OTHER);
    expect(window.localStorage.getItem(ADMIN_HINT_KEY)).toBeNull();
    rememberAdminDevice(ADMIN.toUpperCase().replace("0X", "0x"));
    const stored = JSON.parse(window.localStorage.getItem(ADMIN_HINT_KEY));
    expect(Object.keys(stored).sort()).toEqual(["address", "at"]);
    expect(stored.address).toBe(ADMIN);
    forgetAdminDevice();
    expect(window.localStorage.getItem(ADMIN_HINT_KEY)).toBeNull();
  });
});

describe("silent MetaMask check (local mode)", () => {
  const withEthereum = (accounts) => {
    window.ethereum = { request: jest.fn(async ({ method }) => { if (method === "eth_accounts") return accounts; throw new Error(`unexpected ${method}`); }) };
    return window.ethereum.request;
  };

  test("an allowlisted connected account shows both items and never prompts", async () => {
    const request = withEthereum([OTHER, ADMIN]);
    open(); await settle();
    expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
    expect(screen.getByText("Admin sign-in")).toBeTruthy();
    expect(request.mock.calls.map(([call]) => call.method)).toEqual(["eth_accounts"]);
    expect(request).not.toHaveBeenCalledWith({ method: "eth_requestAccounts" });
  });

  test("a non-admin account, no accounts or a failing provider show nothing", async () => {
    for (const setup of [() => withEthereum([OTHER]), () => withEthereum([]), () => { window.ethereum = { request: async () => { throw new Error("locked"); } }; }]) {
      setup();
      const view = open(); await settle();
      expectNone();
      view.unmount();
    }
  });

  test("it re-checks on window focus", async () => {
    const request = withEthereum([]);
    open(); await settle();
    expectNone();
    request.mockImplementation(async () => [ADMIN]);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
  });
});

test("with the admin scope override: Admin Zone and switch-back are visible, sign-in is hidden", async () => {
  window.sessionStorage.setItem("walletScopeOverride", "admin");
  open(); await settle();
  expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
  expect(screen.getAllByText("Switch back to participant wallet").length).toBeGreaterThan(0);
  expect(screen.queryByText("Admin sign-in")).toBeNull();
});

describe("AdminLoginPage remembers the device", () => {
  const redirect = jest.fn();
  beforeEach(() => redirect.mockClear());
  const clickConnect = () => fireEvent.click(screen.getByRole("button", { name: "Connect MetaMask" }));

  test("success stores the hint before redirecting", async () => {
    mockLogin = async () => ({ ok: true, account: ADMIN });
    render(<AdminLoginPage redirect={redirect} />);
    clickConnect();
    await waitFor(() => expect(redirect).toHaveBeenCalledWith("/manage-budget"));
    expect(hasAdminDeviceHint()).toBe(true);
  });

  test("failure stores nothing", async () => {
    mockLogin = async () => ({ ok: false, message: "Not an admin" });
    render(<AdminLoginPage redirect={redirect} />);
    clickConnect();
    expect((await screen.findByRole("alert")).textContent).toBe("Not an admin");
    expect(redirect).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ADMIN_HINT_KEY)).toBeNull();
  });
});
