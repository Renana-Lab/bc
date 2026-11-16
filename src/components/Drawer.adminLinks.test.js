import React from "react";
import { render, screen } from "@testing-library/react";
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
  expect(screen.getByText("-- Admin Zone --")).toBeTruthy(); // unchanged
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
