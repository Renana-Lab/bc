import { getParticipantId, isValidParticipantId } from "./participantId.mjs";

describe("participant code", () => {
  test("accepts random codes and rejects anything that looks like personal data", () => {
    expect(isValidParticipantId("K7f3QpX9mA2d")).toBe(true);
    for (const bad of ["a@b.com", "0501234567", "12345678", "short1", "has space abc", "a".repeat(40), ""]) {
      expect(isValidParticipantId(bad)).toBe(false);
    }
  });
  test("reads ?pid= and keeps it only in the given session storage", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(getParticipantId({ search: "?pid=K7f3QpX9mA2d", storage })).toBe("K7f3QpX9mA2d");
    expect(getParticipantId({ search: "", storage })).toBe("K7f3QpX9mA2d");
    expect(getParticipantId({ search: "?pid=a@b.com", storage: { getItem: () => null, setItem: () => {} } })).toBe("");
  });
});

