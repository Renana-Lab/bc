import { act, renderHook } from "@testing-library/react";
import {
  SESSION_PASSWORD_KEY,
  clearSessionPassword,
  getSessionPassword,
  isUnauthorizedError,
  setSessionPassword,
  useFaucetSessionPassword,
} from "./faucetSessionPassword";

beforeEach(() => {
  clearSessionPassword();
  window.localStorage.clear();
});

test("the password lives in sessionStorage only, never localStorage", () => {
  setSessionPassword("secret");
  expect(window.sessionStorage.getItem(SESSION_PASSWORD_KEY)).toBe("secret");
  expect(window.localStorage.length).toBe(0);
  clearSessionPassword();
  expect(window.sessionStorage.getItem(SESSION_PASSWORD_KEY)).toBeNull();
  expect(getSessionPassword()).toBe("");
});

test("run() remembers a password that worked, so it is typed at most once per session", async () => {
  const { result } = renderHook(() => useFaucetSessionPassword());
  const action = jest.fn(async (pw) => `ok:${pw}`);
  expect(result.current.hasPassword).toBe(false);
  await act(async () => { expect(await result.current.run("typed", action)).toBe("ok:typed"); });
  expect(result.current.hasPassword).toBe(true);
  await act(async () => { await result.current.run("", action); });
  expect(action).toHaveBeenLastCalledWith("typed"); // second call needs no typing
});

test("run() forgets a password the server refused and keeps it on other errors", async () => {
  const { result } = renderHook(() => useFaucetSessionPassword());
  setSessionPassword("pw");
  await act(async () => { await expect(result.current.run("", async () => { throw new Error("network down"); })).rejects.toThrow("network down"); });
  expect(getSessionPassword()).toBe("pw");
  await act(async () => { await expect(result.current.run("", async () => { throw Object.assign(new Error("nope"), { code: "unauthorized" }); })).rejects.toThrow(); });
  expect(getSessionPassword()).toBe("");
  expect(result.current.hasPassword).toBe(false);
});

test("run() without any password asks for one", async () => {
  const { result } = renderHook(() => useFaucetSessionPassword());
  await act(async () => { await expect(result.current.run("", jest.fn())).rejects.toThrow(/Enter the faucet admin password/); });
});

test("every hook instance sees a password set elsewhere", () => {
  const first = renderHook(() => useFaucetSessionPassword());
  const second = renderHook(() => useFaucetSessionPassword());
  act(() => setSessionPassword("shared"));
  expect(first.result.current.password).toBe("shared");
  expect(second.result.current.password).toBe("shared");
  act(() => second.result.current.forget());
  expect(first.result.current.hasPassword).toBe(false);
});

test("isUnauthorizedError", () => {
  expect(isUnauthorizedError({ code: "unauthorized" })).toBe(true);
  expect(isUnauthorizedError(new Error("Wrong password."))).toBe(true);
  expect(isUnauthorizedError(new Error("busy"))).toBe(false);
});
