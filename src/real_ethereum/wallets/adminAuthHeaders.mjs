// Admin credentials for the faucet's /admin/* routes. A call carries EITHER { proof } (the Admin Zone wallet proof as
// base64url JSON, sent in the x-admin-proof header) OR { password } (x-admin-password header / POST body, the
// break-glass fallback). Neither ever goes into a URL, and the proof wins when both are given.
export const adminAuthHeaders = ({ proof, password } = {}) => (proof ? { "x-admin-proof": proof } : { "x-admin-password": password });

// POST bodies carry the password only when there is no proof.
export const adminBodyAuth = ({ proof, password } = {}) => (proof ? {} : { password });

// 401 -> unauthorized (wrong password / wallet not accepted), 503 with a proof -> unavailable (role could not be checked),
// 429 -> rate_limited. Anything else returns null so the caller picks its own message.
export const adminAuthFailure = (response, { proof } = {}) => {
  if (response.status === 401) {
    return { code: "unauthorized", message: proof ? "The faucet did not accept your admin wallet." : "Wrong password." };
  }
  if (response.status === 503 && proof) {
    return { code: "unavailable", message: "The faucet could not check your admin role right now. Try again." };
  }
  if (response.status === 429) return { code: "rate_limited", message: "Too many attempts. Wait ten minutes and try again." };
  return null;
};
