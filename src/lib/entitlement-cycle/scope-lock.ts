import type { DbClient } from "@/lib/db-client/types";

// PRG-038 / EN-002: deterministic learner/app locking for entitlement activation.
//
// Scope = learner x app x environment (the unit EN-002 materialises one effective entitlement for). Activations on the SAME scope are
// serialised; activations on different learners/apps/environments never wait for each other. Locks are always taken in sorted key
// order, so two activations touching overlapping scope sets (e.g. [math, reading] vs [reading, math]) cannot deadlock.
//
// Two layers:
//   1. in-process keyed lock  - removes the single-connection hazard of the SQLite dev/test adapter and cheaply serialises a node's own requests;
//   2. database row lock      - entitlement_activation_locks rows upserted in sorted order inside the activation transaction. On Postgres the
//                               row write lock is held until commit, so activations on other instances wait and then read the committed
//                               periods (READ COMMITTED) before recomputing roles. Billing/payment events remain the only creation authority:
//                               the lock table carries no entitlement data.
export function entitlementScopeKeys(learnerId: string, appIds: readonly string[], environment: string): string[] {
  return [...new Set(appIds)].sort().map((appId) => `${learnerId}|${appId}|${environment}`);
}

const tails = new Map<string, Promise<unknown>>();

/** Test seam, like resetDbClientForTests: scopes held against a discarded database must not block the next one. */
export function resetEntitlementScopeLocksForTests() {
  tails.clear();
}

// Registers this holder as the new tail for `key`. `wait` is the previous holder's tail (null when the scope is free).
function enqueue(key: string): { wait: Promise<unknown> | null; release: () => void } {
  const previous = tails.get(key) ?? null;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const tail = (previous ?? Promise.resolve()).then(() => gate);
  tails.set(key, tail);
  return { wait: previous, release: () => { open(); if (tails.get(key) === tail) tails.delete(key); } };
}

export function withEntitlementScopeLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  // Uncontended fast path: take every scope and start the work synchronously, and hand back the work's own promise untouched, so a free scope adds
  // no extra asynchronous turns for the caller (existing callers and fixtures are timing-sensitive about how soon an activation completes).
  if (ordered.every((key) => !tails.has(key))) {
    const held = ordered.map(enqueue);
    const releaseAll = () => { for (const h of held.reverse()) h.release(); };
    let work: Promise<T>;
    try { work = fn(); } catch (error) { releaseAll(); return Promise.reject(error); }
    work.then(releaseAll, releaseAll);
    return work;
  }
  return (async () => {
    const held: Array<() => void> = [];
    try {
      for (const key of ordered) {
        const h = enqueue(key);
        held.push(h.release);
        if (h.wait) await h.wait;
      }
      return await fn();
    } finally {
      for (const release of held.reverse()) release();
    }
  })();
}

/** Upserts one lock row per scope, in sorted order, inside the caller's transaction (held until commit on Postgres). */
export async function acquireEntitlementScopeRows(db: DbClient, learnerId: string, appIds: readonly string[], environment: string, now: Date): Promise<void> {
  for (const appId of [...new Set(appIds)].sort()) {
    await db.run(
      `insert into entitlement_activation_locks(learner_id, app_id, environment, lock_seq, updated_at) values(?, ?, ?, 1, ?)
       on conflict(learner_id, app_id, environment) do update set lock_seq = entitlement_activation_locks.lock_seq + 1, updated_at = excluded.updated_at`,
      [learnerId, appId, environment, now.toISOString()],
    );
  }
}
