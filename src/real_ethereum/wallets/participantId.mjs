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
const readValue = ({ fromUrl, isValid, key, storage }) => {
  let value = fromUrl;
  try {
    if (isValid(value)) storage?.setItem(key, value);
    else value = storage?.getItem(key) || "";
  } catch {
    // storage unavailable: use the URL value only
  }
  return isValid(value) ? value : "";
};

// Reads ?pid= / ?PROLIFIC_PID= (plus optional ?study= / ?STUDY_ID= and ?exp=) once and keeps them for the
// browser tab session (sessionStorage), nothing else. Values are never logged.
export const getParticipantContext = ({ search = "", storage } = {}) => {
  const params = new URLSearchParams(search);
  return {
    // Candidate for open-mode faucets. Never sent unless the faucet says it is in open mode.
    openPid: readValue({ fromUrl: firstParam(params, ["pid", "PROLIFIC_PID"]).trim(), isValid: isValidOpenParticipantId, key: OPEN_STORAGE_KEY, storage }),
    pid: readValue({ fromUrl: firstParam(params, ["pid", "PROLIFIC_PID"]), isValid: isValidParticipantId, key: STORAGE_KEY, storage }),
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
