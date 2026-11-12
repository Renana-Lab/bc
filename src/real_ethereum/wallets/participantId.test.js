import { getParticipantContext, getParticipantId, isValidParticipantId, stripParticipantParams } from "./participantId.mjs";

const memoryStorage = () => {
  const store = new Map();
  return { store, getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
};
const PROLIFIC = "5f1a2b3c4d5e6f7a8b9c0d1e";

describe("participant code", () => {
  test("accepts random codes and rejects anything that looks like personal data", () => {
    expect(isValidParticipantId("K7f3QpX9mA2d")).toBe(true);
    for (const bad of ["a@b.com", "0501234567", "12345678", "short1", "has space abc", "a".repeat(40), ""]) {
      expect(isValidParticipantId(bad)).toBe(false);
    }
  });
  test("accepts a 24-hex Prolific id (even all digits) but not 23/25 chars or non-hex", () => {
    expect(isValidParticipantId(PROLIFIC)).toBe(true);
    expect(isValidParticipantId("123456789012345678901234")).toBe(true);
    expect(isValidParticipantId("5F1A2B3C4D5E6F7A8B9C0D1E")).toBe(true);
    expect(isValidParticipantId("123456789012345678901234".slice(1))).toBe(false); // 23 digits: no letter, not 24
    expect(isValidParticipantId(`${PROLIFIC}0`)).toBe(false);
    expect(isValidParticipantId("zzzzzzzzzzzzzzzzzzzzzzzz1")).toBe(false);
  });
  test("reads ?pid= and keeps it only in the given session storage", () => {
    const storage = memoryStorage();
    expect(getParticipantId({ search: "?pid=K7f3QpX9mA2d", storage })).toBe("K7f3QpX9mA2d");
    expect(getParticipantId({ search: "", storage })).toBe("K7f3QpX9mA2d");
    expect(getParticipantId({ search: "?pid=a@b.com", storage: { getItem: () => null, setItem: () => {} } })).toBe("");
  });
  test("reads ?PROLIFIC_PID= as well as ?pid=, and rejects non-ids", () => {
    expect(getParticipantId({ search: `?PROLIFIC_PID=${PROLIFIC}`, storage: memoryStorage() })).toBe(PROLIFIC);
    expect(getParticipantId({ search: `?pid=${PROLIFIC}`, storage: memoryStorage() })).toBe(PROLIFIC);
    for (const bad of ["a@b.com", "0501234567", "nothex-nothex-nothex-nothex", "5f1a2b3c4d5e6f7a8b9c0d1e!"]) {
      expect(getParticipantId({ search: `?PROLIFIC_PID=${bad}`, storage: memoryStorage() })).toBe("");
    }
  });
  test("reads optional study / STUDY_ID and exp, keeps them for the tab, ignores junk", () => {
    const storage = memoryStorage();
    expect(getParticipantContext({ search: `?pid=${PROLIFIC}&study=abc123&exp=Code_9`, storage })).toEqual({ pid: PROLIFIC, studyId: "abc123", experimentCode: "Code_9" });
    expect(getParticipantContext({ search: "", storage })).toEqual({ pid: PROLIFIC, studyId: "abc123", experimentCode: "Code_9" });
    expect(getParticipantContext({ search: `?pid=${PROLIFIC}&STUDY_ID=S-2`, storage: memoryStorage() }).studyId).toBe("S-2");
    expect(getParticipantContext({ search: `?pid=${PROLIFIC}&study=a b<script>&exp=x%20y`, storage: memoryStorage() })).toEqual({ pid: PROLIFIC, studyId: "", experimentCode: "" });
  });
  test("works without storage", () => {
    expect(getParticipantContext({ search: `?pid=${PROLIFIC}` }).pid).toBe(PROLIFIC);
  });
  test("strips every participant param from the address bar and keeps the rest", () => {
    window.history.pushState({}, "", `/auctions?x=1&pid=${PROLIFIC}&PROLIFIC_PID=${PROLIFIC}&study=s&STUDY_ID=s&exp=e#top`);
    expect(stripParticipantParams(window)).toBe(true);
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#top");
    expect(window.location.href).not.toContain(PROLIFIC);
    expect(stripParticipantParams(window)).toBe(false);
  });
});
