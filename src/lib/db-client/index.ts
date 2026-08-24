import type { DbClient } from "@/lib/db-client/types";
import { createSqliteDbClient } from "@/lib/db-client/sqlite-adapter";
import { createPostgresDbClient } from "@/lib/db-client/postgres-adapter";
import { dbClientContext } from "@/lib/db-client/context";

export { dbClientContext };

let cached: DbClient | undefined;

// Real bug found while auditing the migration for live-Postgres safety
// (2026-08-20): on the SQLite adapter, EVERY resolveDbClient() call returns
// the exact same singleton connection object, so a converted function that
// calls another converted function's own resolveDbClient().transaction()
// from inside an already-open transaction "just works" via the SQLite
// adapter's own depth-tracked SAVEPOINT scheme — this is the sanctioned,
// already-shipped "nested transaction" pattern (e.g.
// restoreAccountViaGovernance calling restoreAccount). But the Postgres
// adapter's resolveDbClient() call in that same nested scenario would
// otherwise call pool.connect() again, getting a SEPARATE physical
// connection with no relationship to the outer transaction's connection —
// silently breaking atomicity (the "nested" write can commit/be visible
// independently of the outer transaction) rather than merely erroring.
// dbClientContext (context.ts) makes resolveDbClient() context-aware: while
// executing inside an active transaction() callback (either adapter), any
// call to resolveDbClient() anywhere in that async call stack — even from
// a totally different file several functions deeper — transparently
// resolves to the SAME open transaction's client instead of a fresh one.
// See postgres-adapter.ts's transaction() for the SAVEPOINT-based nested
// implementation this makes possible.

// Single seam every converted repository resolves its client through.
// A deployed environment (Vercel build or runtime — both Production and
// Preview run with NODE_ENV=production) has exactly ONE route to the
// database: Postgres via SUPABASE_DB_URL. There is no silent SQLite
// fallback there — a missing/invalid value fails loudly and immediately
// instead of quietly reconnecting to a local file that doesn't exist on
// Vercel's read-only filesystem (the ENOENT mkdir './data' crash this
// guarded against). Local `next dev` and the test suite (NODE_ENV
// "development"/"test") keep the SQLite fallback so they don't require a
// live Supabase project to run.
export function resolveDbClient(): DbClient {
  const active = dbClientContext.getStore();
  if (active) return active;
  if (cached) return cached;
  const connectionString = process.env.SUPABASE_DB_URL;
  if (connectionString) {
    cached = createPostgresDbClient(connectionString);
    return cached;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SUPABASE_DB_URL is not set. This is a deployed (production) environment — " +
      "there is no local SQLite fallback here. Set SUPABASE_DB_URL to the Postgres " +
      "connection string (Session pooler URI, not the project's https:// API URL) " +
      "in the deployment's environment variables and redeploy.",
    );
  }
  cached = createSqliteDbClient();
  return cached;
}

// Test-only: drop the cached client so the next resolveDbClient() call
// re-resolves against whatever SUPABASE_DB_URL/SQLITE_DB_PATH currently
// point at. Mirrors resetDbForTests() in src/lib/db/client.ts — call
// both together (see src/lib/db/test-utils.ts's useInMemoryDb()).
export function resetDbClientForTests() {
  cached = undefined;
}
