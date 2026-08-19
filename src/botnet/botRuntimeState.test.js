import { hasRunningBrowserBots, isRunningBrowserBot } from "./botRuntimeState";

const privateKey = `0x${"a".repeat(64)}`;

describe("browser bot runtime activation", () => {
  test("activates only for an enabled, running browser bot with a valid key", () => {
    expect(
      isRunningBrowserBot({ running: true, enabled: true, privateKey }),
    ).toBe(true);
    expect(
      isRunningBrowserBot({ running: false, enabled: true, privateKey }),
    ).toBe(false);
    expect(
      isRunningBrowserBot({ running: true, enabled: false, privateKey }),
    ).toBe(false);
    expect(
      isRunningBrowserBot({ running: true, enabled: true, privateKey: "bad" }),
    ).toBe(false);
  });

  test("does not activate the browser runtime for the Node-managed wallet agent", () => {
    expect(
      isRunningBrowserBot({
        running: true,
        enabled: true,
        privateKey,
        walletType: "metamask-agent",
      }),
    ).toBe(false);
  });

  test("reads compatible bot records and tolerates corrupt storage", () => {
    const storageKey = "bots";
    const storage = {
      getItem: jest.fn(() =>
        JSON.stringify([{ running: true, enabled: true, privateKey }]),
      ),
    };
    expect(hasRunningBrowserBots(storage, storageKey)).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith(storageKey);

    storage.getItem.mockReturnValue("not-json");
    expect(hasRunningBrowserBots(storage, storageKey)).toBe(false);
  });
});
