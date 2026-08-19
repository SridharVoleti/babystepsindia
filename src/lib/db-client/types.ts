// Async query/transaction interface every converted repository resolves
// through via resolveDbClient() (see index.ts), instead of calling
// src/lib/db/client.ts's getDb() directly. Two implementations exist —
// sqlite-adapter.ts (wraps today's better-sqlite3 connection unchanged)
// and postgres-adapter.ts (a real pg pool against a live Supabase
// project) — selected by resolveDbClient() based on env var presence,
// mirroring src/lib/deployment-provider/index.ts's resolver.
//
// SQL text written against this interface always uses `?` positional
// placeholders (never `$1`, never named `@param`) — the SQLite adapter
// passes them straight through to better-sqlite3; the Postgres adapter
// translates them to `$1,$2,...` internally. This keeps converted repo
// files' SQL strings dialect-neutral for the placeholder syntax itself;
// any other dialect difference (e.g. `datetime('now')` vs `now()`) still
// needs handling per query, ideally by computing values in JS instead.
export type DbParam = string | number | boolean | null | Buffer;
export type DbParams = ReadonlyArray<DbParam>;

export interface DbClient {
  get<T = unknown>(sql: string, params?: DbParams): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: DbParams): Promise<T[]>;
  run(sql: string, params?: DbParams): Promise<{ changes: number }>;
  // The callback must perform only sequential awaited DbClient calls and
  // pure computation — no other async I/O (network calls, timers, other
  // DB connections). See sqlite-adapter.ts's transaction() for why.
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}
