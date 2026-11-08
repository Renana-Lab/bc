const DB_NAME = "marketplace-protected-keys-v1";
const operations = new Map();

const scope = (wallet, chainId) => {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || "") || !Number.isSafeInteger(Number(chainId))) {
    throw new Error("Invalid delivery key scope");
  }
  return `${Number(chainId)}:${wallet.toLowerCase()}`;
};

const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("keys");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error("Secure browser key storage is unavailable"));
});

const access = async (key, value) => {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("keys", value ? "readwrite" : "readonly");
      const store = transaction.objectStore("keys");
      const request = store.get(key);
      let result;
      request.onsuccess = () => {
        result = request.result;
        if (!result && value) { store.put(value, key); result = value; }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error("Delivery key storage failed"));
    });
  } finally { db.close(); }
};

export const getDeliveryKey = (wallet, chainId, generate) => {
  const key = scope(wallet, chainId);
  if (!operations.has(key)) {
    const operation = (async () => {
      const stored = await access(key);
      if (stored) return stored;
      // A cross-tab lock prevents two tabs from replacing a newly generated key.
      const create = async () => (await access(key)) || access(key, await generate());
      return navigator.locks ? navigator.locks.request(`${DB_NAME}:${key}`, create) : create();
    })();
    operations.set(key, operation);
    operation.catch(() => operations.delete(key));
  }
  return operations.get(key);
};
