import type { RuntimeRecord, RecoveryCapsuleRecord } from "./types";

const DB_NAME = "babysteps-session-runtime";
const RUNTIME_STORE = "runtimes";
const RECOVERY_CAPSULE_STORE = "recoveryCapsules";

// SC-001 IndexedDB is versioned independently of the SDK build's own
// CURRENT_RUNTIME_VERSION (see migrations.ts) — this is the *database
// schema* version (object stores/indexes). PR-002 bumps this 1 -> 2 to add
// the recoveryCapsules store, additive only — the existing runtimes
// store/data is untouched by this upgrade.
const DB_SCHEMA_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUNTIME_STORE)) db.createObjectStore(RUNTIME_STORE, { keyPath: "sessionId" });
      if (!db.objectStoreNames.contains(RECOVERY_CAPSULE_STORE)) db.createObjectStore(RECOVERY_CAPSULE_STORE, { keyPath: "sessionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = fn(tx.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function getRuntimeRecord(sessionId: string) {
  return withStore<RuntimeRecord | undefined>(RUNTIME_STORE, "readonly", (store) => store.get(sessionId));
}

export function putRuntimeRecord(record: RuntimeRecord) {
  return withStore<IDBValidKey>(RUNTIME_STORE, "readwrite", (store) => store.put(record));
}

export function deleteRuntimeRecord(sessionId: string) {
  return withStore<undefined>(RUNTIME_STORE, "readwrite", (store) => store.delete(sessionId));
}

export function getRecoveryCapsuleRecord(sessionId: string) {
  return withStore<RecoveryCapsuleRecord | undefined>(RECOVERY_CAPSULE_STORE, "readonly", (store) => store.get(sessionId));
}

export function putRecoveryCapsuleRecord(record: RecoveryCapsuleRecord) {
  return withStore<IDBValidKey>(RECOVERY_CAPSULE_STORE, "readwrite", (store) => store.put(record));
}

export function deleteRecoveryCapsuleRecord(sessionId: string) {
  return withStore<undefined>(RECOVERY_CAPSULE_STORE, "readwrite", (store) => store.delete(sessionId));
}
