// The invisible-wallet host registers the active wallet here so the admin-only restore screen can reach it.
let active = null;
export const setActiveLocalWallet = (wallet) => { active = wallet; };
export const getActiveLocalWallet = () => active;
