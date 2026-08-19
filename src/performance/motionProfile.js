export const MOTION_PROFILE_KEY = "bc:motion-profile:v1";
export const MOTION_PROFILES = Object.freeze({
  RICH: "rich",
  BALANCED: "balanced",
  REDUCED: "reduced",
});

const mediaMatches = (query) =>
  typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches);

export const resolveMotionProfile = ({
  reducedMotion = false,
  slowUpdate = false,
  saveData = false,
  hardwareConcurrency = 8,
  deviceMemory,
} = {}) => {
  if (reducedMotion) return MOTION_PROFILES.REDUCED;
  if (
    slowUpdate ||
    saveData ||
    Number(hardwareConcurrency || 0) <= 4 ||
    (deviceMemory !== undefined && Number(deviceMemory) <= 4)
  ) {
    return MOTION_PROFILES.BALANCED;
  }
  return MOTION_PROFILES.RICH;
};

const applyProfile = (profile) => {
  document.documentElement.dataset.motionProfile = profile;
  return profile;
};

const calibrateFrames = () =>
  new Promise((resolve) => {
    if (typeof window.requestAnimationFrame !== "function" || document.hidden) {
      resolve(null);
      return;
    }

    const samples = [];
    let previous = 0;
    const sample = (timestamp) => {
      if (previous) samples.push(timestamp - previous);
      previous = timestamp;
      if (samples.length >= 12) {
        const ordered = [...samples].sort((a, b) => a - b);
        resolve({
          average: samples.reduce((sum, value) => sum + value, 0) / samples.length,
          p95: ordered[Math.floor(ordered.length * 0.95)] || ordered.at(-1),
        });
        return;
      }
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  });

export const initializeMotionProfile = () => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let stored = "";
  try {
    stored = window.sessionStorage.getItem(MOTION_PROFILE_KEY) || "";
  } catch (_) {
    // Session storage is an optimization only.
  }
  if (Object.values(MOTION_PROFILES).includes(stored)) {
    applyProfile(stored);
    return;
  }

  const initial = resolveMotionProfile({
    reducedMotion: mediaMatches("(prefers-reduced-motion: reduce)"),
    slowUpdate: mediaMatches("(update: slow)"),
    saveData: Boolean(navigator.connection?.saveData),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
  });
  applyProfile(initial);

  const lockProfile = (profile) => {
    applyProfile(profile);
    try {
      window.sessionStorage.setItem(MOTION_PROFILE_KEY, profile);
    } catch (_) {
      // The applied DOM attribute remains authoritative for this page.
    }
  };

  if (initial !== MOTION_PROFILES.RICH) {
    lockProfile(initial);
    return;
  }

  window.setTimeout(async () => {
    const frames = await calibrateFrames();
    const profile = frames && (frames.average > 20 || frames.p95 > 26)
      ? MOTION_PROFILES.BALANCED
      : MOTION_PROFILES.RICH;
    lockProfile(profile);
  }, 0);
};

