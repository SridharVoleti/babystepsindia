import type { DbClient } from "@/lib/db-client/types";
import { createSqliteDbClient } from "@/lib/db-client/sqlite-adapter";
import { createPostgresDbClient } from "@/lib/db-client/postgres-adapter";

let cached: DbClient | undefined;

// Single seam every converted repository resolves its client through —
// Postgres (a live Supabase project) when SUPABASE_DB_URL is configured,
// otherwise the existing local SQLite backend. Mirrors
// resolveDeploymentProvider() (src/lib/deployment-provider/index.ts):
// selection is gated on env var presence, not an explicit mode flag.
export function resolveDbClient(): DbClient {
  if (cached) return cached;
  const connectionString = process.env.SUPABASE_DB_URL;
  cached = connectionString ? createPostgresDbClient(connectionString) : createSqliteDbClient();
  return cached;
}

// Test-only: drop the cached client so the next resolveDbClient() call
// re-resolves against whatever SUPABASE_DB_URL/SQLITE_DB_PATH currently
// point at. Mirrors resetDbForTests() in src/lib/db/client.ts — call
// both together (see src/lib/db/test-utils.ts's useInMemoryDb()).
export function resetDbClientForTests() {
  cached = undefined;
}
