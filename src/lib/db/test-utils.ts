import { resetDbForTests } from "@/lib/db/client";

// Points the (lazily-opened, globally-cached) SQLite connection at a fresh
// in-memory database and drops any previously cached handle, so each test
// gets isolated storage instead of sharing ./data/babysteps.db.
export function useInMemoryDb() {
  process.env.SQLITE_DB_PATH = ":memory:";
  resetDbForTests();
}
