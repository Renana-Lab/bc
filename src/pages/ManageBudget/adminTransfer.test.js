import { waitForReceipt } from "./adminTransfer";

test("waitForReceipt: true when mined ok, false when mined but reverted, null when not seen before the timeout", async () => {
  expect(await waitForReceipt("0x1", { read: async () => ({ status: true }), sleep: async () => {} })).toBe(true);
  expect(await waitForReceipt("0x1", { read: async () => ({ status: 0 }), sleep: async () => {} })).toBe(false);
  expect(await waitForReceipt("0x1", { read: async () => null, sleep: async () => {}, timeoutMs: 0 })).toBeNull();
});

test("waitForReceipt keeps polling until the receipt shows up", async () => {
  const read = jest.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("rpc")).mockResolvedValue({ status: "0x1" });
  expect(await waitForReceipt("0x1", { read, sleep: async () => {} })).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
});
