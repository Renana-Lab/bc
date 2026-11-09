// Anonymous participant code (?pid=...). It is a random code handed out by the lab, never an
// email, phone number or name: the format check rejects anything that looks like personal data.
const PID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{8,24}$/;
const STORAGE_KEY = "data-market:participant-code";

export const isValidParticipantId = (value) => typeof value === "string" && PID_PATTERN.test(value);

// Reads ?pid= once and keeps it for the browser tab session (sessionStorage), nothing else.
export const getParticipantId = ({ search = "", storage } = {}) => {
  let pid = new URLSearchParams(search).get("pid") || "";
  try {
    if (isValidParticipantId(pid)) storage?.setItem(STORAGE_KEY, pid);
    else pid = storage?.getItem(STORAGE_KEY) || "";
  } catch {
    // storage unavailable: use the URL value only
  }
  return isValidParticipantId(pid) ? pid : "";
};
