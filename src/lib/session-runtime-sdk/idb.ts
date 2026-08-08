import type { RuntimeRecord } from "./types";

const DB_NAME = "babysteps-session-runtime";
const STORE = "runtimes";

// SC-001 IndexedDB is versioned independently of the SDK build's own
// CURRENT_RUNTIME_VERSION (see migrations.ts) — this is the *database
// schema* version (object stores/indexes), bumped only if the store shape
// itself changes, not on every runtime-record format change.
const DB_SCHEMA_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "sessionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function getRuntimeRecord(sessionId: string) {
  return withStore<RuntimeRecord | undefined>("readonly", (store) => store.get(sessionId));
}

export function putRuntimeRecord(record: RuntimeRecord) {
  return withStore<IDBValidKey>("readwrite", (store) => store.put(record));
}

export function deleteRuntimeRecord(sessionId: string) {
  return withStore<undefined>("readwrite", (store) => store.delete(sessionId));
}
