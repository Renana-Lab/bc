import { MOTION_PROFILES, resolveMotionProfile } from "./motionProfile";

describe("motion profile selection", () => {
  test("honors reduced-motion before hardware capability", () => {
    expect(
      resolveMotionProfile({
        reducedMotion: true,
        hardwareConcurrency: 16,
        deviceMemory: 16,
      }),
    ).toBe(MOTION_PROFILES.REDUCED);
  });

  test.each([
    [{ saveData: true }, "save-data"],
    [{ slowUpdate: true }, "slow refresh capability"],
    [{ hardwareConcurrency: 4 }, "limited CPU"],
    [{ hardwareConcurrency: 8, deviceMemory: 4 }, "limited memory"],
  ])("uses balanced motion for %s", (capabilities) => {
    expect(resolveMotionProfile(capabilities)).toBe(MOTION_PROFILES.BALANCED);
  });

  test("keeps rich motion on capable devices", () => {
    expect(
      resolveMotionProfile({ hardwareConcurrency: 8, deviceMemory: 8 }),
    ).toBe(MOTION_PROFILES.RICH);
  });
});
