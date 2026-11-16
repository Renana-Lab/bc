// Input limits for the create-auction form (mirrors the marketplace release rules).
export const DESCRIPTION_MAX_CHARS = 300;
// One config constant for the confidential payload size. The on-chain cap is in BYTES (UTF-8),
// so Hebrew and other non-Latin text counts 2+ bytes per character. Override with REACT_APP_PAYLOAD_MAX_BYTES.
export const PAYLOAD_MAX_BYTES = Number(process.env.REACT_APP_PAYLOAD_MAX_BYTES) > 0
  ? Number(process.env.REACT_APP_PAYLOAD_MAX_BYTES)
  : 2000;

export const utf8ByteLength = (text) => {
  const value = String(text ?? "");
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};
export const MIN_BID_MAX = 1000000000;
export const DURATION_MIN = 1;
export const DURATION_MAX = 30;
export const DEFAULT_DURATION = "10";
export const DESCRIPTION_WORDS_MESSAGE = "The data description must include words, not only numbers";

const isWholeNumber = (value) => /^\d+$/.test(String(value ?? "").trim());

// Returns { field: message } for every invalid field; empty when the form is valid.
export const validateAuctionForm = (form) => {
  const errors = {};
  const description = String(form.dataDescription ?? "").trim();
  if (!description) errors.dataDescription = "Description of the data is required";
  else if (description.length > DESCRIPTION_MAX_CHARS) {
    errors.dataDescription = `The description can be at most ${DESCRIPTION_MAX_CHARS} characters`;
  } else if (!/\p{L}/u.test(description)) errors.dataDescription = DESCRIPTION_WORDS_MESSAGE;

  const payload = String(form.dataForSell ?? "");
  if (!payload.trim()) errors.dataForSell = "Data for sale is required";
  else if (utf8ByteLength(payload) > PAYLOAD_MAX_BYTES) {
    errors.dataForSell = `The data can be at most ${PAYLOAD_MAX_BYTES} bytes (Hebrew and other non-Latin letters use 2 or more bytes each)`;
  }

  const minimum = String(form.minimumContribution ?? "").trim();
  if (!isWholeNumber(minimum) || Number(minimum) < 1 || Number(minimum) > MIN_BID_MAX) {
    errors.minimumContribution = `Minimum bid must be a whole number from 1 to ${MIN_BID_MAX.toLocaleString("en-US")}`;
  }

  const duration = String(form.auctionDuration ?? "").trim();
  if (!isWholeNumber(duration) || Number(duration) < DURATION_MIN || Number(duration) > DURATION_MAX) {
    errors.auctionDuration = `Auction duration must be a whole number of minutes from ${DURATION_MIN} to ${DURATION_MAX}`;
  }
  return errors;
};
