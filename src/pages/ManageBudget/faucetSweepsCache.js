// One GET /admin/sweeps per page load is shared by every admin card that needs the faucet's sweep records
// (Participants gas auto-return, Users and budgets "Last seen"). A result is reused for 30 s; a request already in
// flight is joined instead of repeated. `force` (an explicit button press) skips the cached result.
export const SWEEPS_CACHE_TTL_MS = 30_000;

const entries = new Map(); // key -> { at, data, promise }

export const resetSweepsCache = () => entries.clear();

export const fetchSweepsShared = ({ key = "", fetcher, force = false, now = Date.now }) => {
  const entry = entries.get(key);
  if (entry?.promise) return entry.promise;
  if (!force && entry && now() - entry.at < SWEEPS_CACHE_TTL_MS) return Promise.resolve(entry.data);
  const promise = Promise.resolve().then(fetcher).then(
    (data) => { entries.set(key, { at: now(), data, promise: null }); return data; },
    (error) => { entries.delete(key); throw error; },
  );
  entries.set(key, { at: entry?.at ?? 0, data: entry?.data, promise });
  return promise;
};
