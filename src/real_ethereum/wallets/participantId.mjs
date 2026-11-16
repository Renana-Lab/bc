// Anonymous participant id. Two kinds are accepted, never an email, phone number or name:
//  * a Prolific participant id: exactly 24 hex characters (e.g. from ?PROLIFIC_PID= or ?pid=);
//  * a random lab code of 8-24 letters/digits that contains at least one letter (the allowlist mode).
// The format check rejects anything that looks like personal data.
const LAB_CODE_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{8,24}$/;
const PROLIFIC_PATTERN = /^[a-fA-F0-9]{24}$/;
// Faucet "open" mode (FAUCET_PID_MODE=open): any trimmed printable-ASCII id of 1-128 characters, case-sensitive.
// It is only used after GET /status reports pidMode "open", because such an id can look like personal data
// (an email address, say) which the stricter formats above rule out.
const OPEN_PATTERN = /^[!-~]{1,128}$/;
const OPEN_STORAGE_KEY = "data-market:participant-code-open";
// Long-lived copy (localStorage) of the last valid id, used ONLY when this tab has none (new tab, bookmark without ?pid=),
// so the same browser keeps reusing the same wallet.
const LAST_PID_KEY = "data-market:last-participant-code";
const LAST_OPEN_PID_KEY = "data-market:last-participant-code-open";
const STUDY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EXPERIMENT_PATTERN = /^[A-Za-z0-9_.~-]{1,64}$/;
const STORAGE_KEY = "data-market:participant-code";
const STUDY_KEY = "data-market:study-id";
const EXPERIMENT_KEY = "data-market:experiment-code";

// Every query parameter that carries a participant/study/experiment value. All are removed from the address bar.
export const PARTICIPANT_PARAMS = ["pid", "PROLIFIC_PID", "study", "STUDY_ID", "exp"];

export const isValidOpenParticipantId = (value) => typeof value === "string" && OPEN_PATTERN.test(value);

export const isValidParticipantId = (value) => typeof value === "string" && (PROLIFIC_PATTERN.test(value) || LAB_CODE_PATTERN.test(value));

const firstParam = (params, names) => {
  for (const name of names) {
    const value = params.get(name);
    if (value) return value;
  }
  return "";
};

// Reads one value from the URL (when valid, remembering it for the tab session) or falls back to the stored one.
// `lastKey` + `persistentStorage`: the last valid value also survives in the long-lived storage and is read only when
// neither the URL nor the tab session has one.
// `strictUrl` (participant ids): when the URL DOES carry the parameter but its value is invalid, the answer is "" and the
// remembered values are dropped. An invalid link must never silently reuse another participant's id.
const readValue = ({ fromUrl, isValid, key, storage, lastKey, persistentStorage, strictUrl = false }) => {
  let value = fromUrl;
  if (isValid(value)) {
    try { storage?.setItem(key, value); } catch { /* storage unavailable: use the URL value only */ }
    if (lastKey) { try { persistentStorage?.setItem(lastKey, value); } catch { /* ignore */ } }
    return value;
  }
  if (strictUrl && fromUrl) {
    try { storage?.removeItem?.(key); } catch { /* ignore */ }
    if (lastKey) { try { persistentStorage?.removeItem?.(lastKey); } catch { /* ignore */ } }
    return "";
  }
  value = "";
  try { value = storage?.getItem(key) || ""; } catch { value = ""; }
  if (!isValid(value) && lastKey) {
    try { value = persistentStorage?.getItem(lastKey) || ""; } catch { value = ""; }
  }
  return isValid(value) ? value : "";
};

// Reads ?pid= / ?PROLIFIC_PID= (plus optional ?study= / ?STUDY_ID= and ?exp=) once and keeps them for the
// browser tab session (sessionStorage). Only the participant id is also remembered in `persistentStorage`
// (localStorage) as a fallback for tabs that have none. Values are never logged.
export const getParticipantContext = ({ search = "", storage, persistentStorage } = {}) => {
  const params = new URLSearchParams(search);
  return {
    // Candidate for open-mode faucets. Never sent unless the faucet says it is in open mode.
    openPid: readValue({ fromUrl: firstParam(params, ["pid", "PROLIFIC_PID"]).trim(), isValid: isValidOpenParticipantId, key: OPEN_STORAGE_KEY, storage, lastKey: LAST_OPEN_PID_KEY, persistentStorage, strictUrl: true }),
    pid: readValue({ fromUrl: firstParam(params, ["pid", "PROLIFIC_PID"]), isValid: isValidParticipantId, key: STORAGE_KEY, storage, lastKey: LAST_PID_KEY, persistentStorage, strictUrl: true }),
    studyId: readValue({ fromUrl: firstParam(params, ["study", "STUDY_ID"]), isValid: (v) => STUDY_PATTERN.test(v), key: STUDY_KEY, storage }),
    experimentCode: readValue({ fromUrl: firstParam(params, ["exp"]), isValid: (v) => EXPERIMENT_PATTERN.test(v), key: EXPERIMENT_KEY, storage }),
  };
};

export const getParticipantId = (options = {}) => getParticipantContext(options).pid;

// The id is a faucet capability: keep it out of the address bar, history and Referer headers.
// Returns true when something was removed.
export const stripParticipantParams = (win) => {
  try {
    const url = new URL(win.location.href);
    const present = PARTICIPANT_PARAMS.filter((name) => url.searchParams.has(name));
    if (!present.length) return false;
    present.forEach((name) => url.searchParams.delete(name));
    win.history.replaceState(win.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return true;
  } catch {
    return false; // not fatal
  }
};

// Asks the browser not to evict the wallet's IndexedDB under storage pressure. Once per page load; failures are ignored.
let persistRequested = false;
export const requestPersistentStorage = (nav = globalThis.navigator) => {
  if (persistRequested) return Promise.resolve(false);
  persistRequested = true;
  try {
    return Promise.resolve(nav?.storage?.persist?.()).then((granted) => Boolean(granted), () => false);
  } catch {
    return Promise.resolve(false);
  }
};
export const __resetPersistForTests = () => { persistRequested = false; };
