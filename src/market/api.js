const requests = new Set();
let suspended = false;
const abortAll = () => {
  suspended = true;
  for (const controller of requests) {
    try { controller.abort(); } catch {}
  }
};
window.addEventListener('beforeunload', abortAll);
window.addEventListener('pagehide', abortAll);
window.addEventListener('unload', abortAll);
window.addEventListener('pageshow', () => { suspended = false; });

export async function marketApi(path, body, headers) {
  if (suspended) throw new DOMException('Page suspended', 'AbortError');
  const controller = new AbortController();
  requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/market${path}`, {
      credentials: 'same-origin', signal: controller.signal,
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    });
    if (suspended) throw new DOMException('Page suspended', 'AbortError');
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || 'Request failed');
      error.status = response.status;
      throw error;
    }
    return value;
  } finally { clearTimeout(timer); requests.delete(controller); }
}
