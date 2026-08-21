import { getDb } from "@/lib/db/client";
import type { DbClient, DbParams } from "@/lib/db-client/types";

// Wraps the existing, unchanged getDb() singleton in the async DbClient
// shape — behavior is identical to every one of the ~110 files still
// calling getDb() directly; this only exists so converted repository
// files can be written once against DbClient and swap backends via
// resolveDbClient() rather than forking their query code per-backend.
export function createSqliteDbClient(): DbClient {
  const db = getDb();
  const sqliteParams = (params: DbParams) => params.map((value) =>
    typeof value === "boolean" ? (value ? 1 : 0) : value,
  );

  const get = <T,>(sql: string, params: DbParams = []) =>
    Promise.resolve(db.prepare(sql).get(...sqliteParams(params)) as T | undefined);
  const all = <T,>(sql: string, params: DbParams = []) =>
    Promise.resolve(db.prepare(sql).all(...sqliteParams(params)) as T[]);
  const run = (sql: string, params: DbParams = []) =>
    Promise.resolve({ changes: db.prepare(sql).run(...sqliteParams(params)).changes });

  const client: DbClient = {
    get,
    all,
    run,
    // better-sqlite3's own db.transaction() rejects an async callback
    // outright ("Transaction function cannot return a promise"), so it
    // can't be used here — BEGIN/COMMIT/ROLLBACK are issued manually
    // instead. This is only correct because the callback is required
    // (see types.ts) to do nothing but sequential awaited DbClient calls:
    // with no other async I/O in between, Node never yields the event
    // loop mid-transaction, so no other request's continuation can
    // interleave a write into this connection's open transaction. This
    // is the same implicit synchronous-callback contract every existing
    // db.transaction() call site in this codebase already relies on,
    // just stated explicitly here since transaction() now has an async
    // signature.
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      try {
        const result = await fn(client);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return client;
}
