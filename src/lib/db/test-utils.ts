import { resetDbForTests } from "@/lib/db/client";
import { resetDbClientForTests } from "@/lib/db-client";

// Points the (lazily-opened, globally-cached) SQLite connection at a fresh
// in-memory database and drops any previously cached handle, so each test
// gets isolated storage instead of sharing ./data/babysteps.db. Also drops
// the cached DbClient from src/lib/db-client — otherwise a converted
// repository file would keep reusing a SqliteDbClient wrapping the
// previous test's now-closed better-sqlite3 handle.
export function useInMemoryDb() {
  process.env.SQLITE_DB_PATH = ":memory:";
  resetDbForTests();
  resetDbClientForTests();
}
