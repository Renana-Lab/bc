import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import FaucetAdminPage from "./FaucetAdminPage.js";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const PASSWORD = "correct horse battery staple";

const fakeFaucet = ({ open = false, password = PASSWORD } = {}) => {
  const state = { open, calls: [] };
  const fetchImpl = jest.fn(async (url, init = {}) => {
    state.calls.push({ url, init });
    if (url.endsWith("/status")) return reply(200, { open: state.open, updatedAt: null });
    const body = JSON.parse(init.body);
    if (body.password !== password) return reply(401, { error: "unauthorized" });
    state.open = body.open;
    return reply(200, { open: state.open, updatedAt: "2026-01-01T00:00:00.000Z" });
  });
  return { state, fetchImpl };
};

describe("faucet admin page", () => {
  test("password field is type=password with autocomplete off; shows the status from /status", async () => {
    const { fetchImpl } = fakeFaucet();
    render(<FaucetAdminPage faucetUrl="https://f.example" fetchImpl={fetchImpl} />);
    const field = screen.getByLabelText("Admin password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "new-password");
    await waitFor(() => expect(screen.getByTestId("faucet-status")).toHaveTextContent("Closed"));
    expect(fetchImpl.mock.calls[0][0]).toBe("https://f.example/status");
  });

  test("Open calls /admin/state then refreshes the status; the password is never persisted and is cleared", async () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const { state, fetchImpl } = fakeFaucet();
    const logs = [jest.spyOn(console, "log").mockImplementation(() => {}), jest.spyOn(console, "error").mockImplementation(() => {})];
    render(<FaucetAdminPage faucetUrl="https://f.example" fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByTestId("faucet-status")).toHaveTextContent("Closed"));
    fireEvent.change(screen.getByLabelText("Admin password"), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Open faucet" }));
    await waitFor(() => expect(screen.getByTestId("faucet-status")).toHaveTextContent("Open"));
    expect(state.open).toBe(true);
    const urls = state.calls.map((c) => c.url);
    expect(urls).toEqual(["https://f.example/status", "https://f.example/admin/state", "https://f.example/status"]);
    expect(screen.getByLabelText("Admin password")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Close faucet" })).toBeDisabled(); // empty password
    // Nothing was written to browser storage, nor logged, and the password is not in the DOM or the URL.
    expect(setItem).not.toHaveBeenCalled();
    for (const store of [window.localStorage, window.sessionStorage]) expect(JSON.stringify({ ...store })).not.toContain(PASSWORD);
    logs.forEach((spy) => expect(JSON.stringify(spy.mock.calls)).not.toContain(PASSWORD));
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(window.location.href).not.toContain(PASSWORD);
    setItem.mockRestore();
    logs.forEach((spy) => spy.mockRestore());
  });

  test("a wrong password shows a short message and leaves the status unchanged", async () => {
    const { state, fetchImpl } = fakeFaucet();
    render(<FaucetAdminPage faucetUrl="https://f.example" fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByTestId("faucet-status")).toHaveTextContent("Closed"));
    fireEvent.change(screen.getByLabelText("Admin password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Open faucet" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Wrong password."));
    expect(state.open).toBe(false);
    expect(screen.getByLabelText("Admin password")).toHaveValue("");
  });

  test("an open faucet offers Close", async () => {
    const { fetchImpl } = fakeFaucet({ open: true });
    render(<FaucetAdminPage faucetUrl="https://f.example" fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close faucet" })).toBeInTheDocument());
  });
});
