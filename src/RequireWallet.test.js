import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RequireWallet } from "./App";

let mockSession;
jest.mock("./Context/Context", () => ({ useMetaMask: () => mockSession, MetaMaskProvider: ({ children }) => children }));
jest.mock("./botnet/BotnetRuntimeHost", () => () => null);
jest.mock("./telemetry/PresenceCoordinator", () => () => null);

const tree = () => (
  <MemoryRouter initialEntries={["/protected"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes>
      <Route path="/protected" element={<RequireWallet><h1>Protected page</h1></RequireWallet>} />
      <Route path="/metamask-login" element={<h1>Login</h1>} />
    </Routes>
  </MemoryRouter>
);

test("before admission the full-screen check is shown and children are not", () => {
  mockSession = { status: "checking" };
  render(tree());
  expect(screen.getByText("Verifying your MetaMask connection")).toBeTruthy();
  expect(screen.queryByText("Protected page")).toBeNull();
});

test("after admission a checking status neither hides the page nor shows the overlay", () => {
  mockSession = { status: "connected" };
  const view = render(tree());
  expect(screen.getByText("Protected page")).toBeTruthy();
  mockSession = { status: "checking" };
  view.rerender(tree());
  expect(screen.getByText("Protected page")).toBeTruthy();
  expect(screen.queryByText("Verifying your MetaMask connection")).toBeNull();
});

test.each(["locked", "unauthorized", "unavailable"])("after admission %s redirects to login", (status) => {
  mockSession = { status: "connected" };
  const view = render(tree());
  mockSession = { status };
  view.rerender(tree());
  expect(screen.getByText("Login")).toBeTruthy();
});
