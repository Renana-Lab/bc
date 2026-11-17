import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DrawerComponent from "./Drawer";

const mockAccess = { isAdmin: false, onAllowlist: false };
jest.mock("../pages/ManageBudget/useAdminAccess", () => ({ useAdminAccess: () => mockAccess }));

const open = () => render(
  <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <DrawerComponent open toggleDrawerHandler={() => {}} />
  </MemoryRouter>,
);

beforeEach(() => { process.env.REACT_APP_WALLET_MODE = "local"; window.sessionStorage.clear(); mockAccess.isAdmin = false; mockAccess.onAllowlist = false; });
afterEach(() => { delete process.env.REACT_APP_WALLET_MODE; window.sessionStorage.clear(); });

test("participants do not see the admin sign-in or admin wallet links", () => {
  open();
  expect(screen.queryByText("Admin sign-in")).toBeNull();
  expect(screen.queryByText("Admin wallet")).toBeNull();
  expect(screen.queryByText("-- Admin Zone --")).toBeNull(); // market parity: admins only
});

test("an admin (allowlisted or signed in) sees the Admin Zone item", () => {
  mockAccess.onAllowlist = true;
  open();
  expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
});

test("a signed-in admin sees the Admin Zone item in MetaMask mode too", () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  mockAccess.isAdmin = true;
  open();
  expect(screen.getByText("-- Admin Zone --")).toBeTruthy();
});

test("local mode adds Account Profile and Platform Guide after Start An Auction; MetaMask mode keeps the tutorial", () => {
  open();
  const labels = screen.getAllByRole("button").map((el) => el.textContent);
  expect(labels.indexOf("Account Profile")).toBe(labels.indexOf("Start An Auction") + 1);
  expect(labels.indexOf("Platform Guide")).toBe(labels.indexOf("Account Profile") + 1);
  expect(screen.queryByText("Metamask Tutorial")).toBeNull();
});

test("MetaMask mode shows the tutorial and neither new item", () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  open();
  expect(screen.getByText("Metamask Tutorial")).toBeTruthy();
  expect(screen.queryByText("Account Profile")).toBeNull();
  expect(screen.queryByText("Platform Guide")).toBeNull();
});

test("an admin account sees both links", () => {
  mockAccess.onAllowlist = true;
  open();
  expect(screen.getByText("Admin sign-in")).toBeTruthy();
  expect(screen.getByText("Admin wallet")).toBeTruthy();
});

test("an admin with an active MetaMask override no longer needs the sign-in link", () => {
  mockAccess.isAdmin = true;
  window.sessionStorage.setItem("walletModeOverride", "metamask");
  process.env.REACT_APP_WALLET_MODE = "local";
  open();
  expect(screen.queryByText("Admin sign-in")).toBeNull();
});

test("MetaMask-mode builds never show them", () => {
  process.env.REACT_APP_WALLET_MODE = "metamask";
  mockAccess.isAdmin = true;
  open();
  expect(screen.queryByText("Admin sign-in")).toBeNull();
  expect(screen.queryByText("Admin wallet")).toBeNull();
});

test("while any wallet override is active the drawer offers 'Switch back to participant wallet' (even in the resulting MetaMask mode)", () => {
  window.sessionStorage.setItem("walletModeOverride", "metamask"); // account need not be on the env allowlist
  const reload = jest.fn();
  const original = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
  try {
    open();
    fireEvent.click(screen.getByText("Switch back to participant wallet"));
    expect(window.sessionStorage.getItem("walletModeOverride")).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  } finally { Object.defineProperty(window, "location", { configurable: true, value: original }); }
});

test("an imported-key (scope) override shows it too, and without an override it is absent", () => {
  open();
  expect(screen.queryByText("Switch back to participant wallet")).toBeNull();
  window.sessionStorage.setItem("walletScopeOverride", "admin");
  open();
  expect(screen.getAllByText("Switch back to participant wallet").length).toBeGreaterThan(0);
});

test("a participant's drawer in local mode contains no forbidden wording (the admin-only items are allowlisted)", () => {
  const { scanParticipantView } = require("../tests/participantWording");
  const { container } = open();
  expect(scanParticipantView(container, { allow: ["Switch back to participant wallet", "Admin wallet"] })).toEqual({ words: [], addresses: [] });
  // The allowlist entries above are admin-only items a participant never sees:
  expect(screen.queryByText("Admin wallet")).toBeNull();
  expect(screen.queryByText("Switch back to participant wallet")).toBeNull();
});
