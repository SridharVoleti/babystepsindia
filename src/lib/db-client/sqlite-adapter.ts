import { getDb } from "@/lib/db/client";
import type { DbClient, DbParams } from "@/lib/db-client/types";

// Wraps the existing, unchanged getDb() singleton in the async DbClient
// shape — behavior is identical to every one of the ~110 files still
// calling getDb() directly; this only exists so converted repository
// files can be written once against DbClient and swap backends via
// resolveDbClient() rather than forking their query code per-backend.
export function createSqliteDbClient(): DbClient {
  const db = getDb();
  // Depth of open transaction() calls on this connection — a converted
  // repository function (e.g. account-security-repo's restoreAccount) is
  // free to call resolveDbClient().transaction() while it's already
  // running inside an outer converted function's own transaction() (e.g.
  // platform-governance's restoreAccountViaGovernance). SQLite itself
  // rejects a bare nested `BEGIN`, so depth > 1 opens a SAVEPOINT instead
  // — the same nesting behavior better-sqlite3's own high-level
  // db.transaction() already gave every pre-existing call site for free.
  let depth = 0;

  const get = <T,>(sql: string, params: DbParams = []) =>
    Promise.resolve(db.prepare(sql).get(...params) as T | undefined);
  const all = <T,>(sql: string, params: DbParams = []) =>
    Promise.resolve(db.prepare(sql).all(...params) as T[]);
  const run = (sql: string, params: DbParams = []) =>
    Promise.resolve({ changes: db.prepare(sql).run(...params).changes });

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
      depth += 1;
      const savepoint = `dbc_sp_${depth}`;
      const nested = depth > 1;
      nested ? db.exec(`SAVEPOINT ${savepoint}`) : db.exec("BEGIN");
      try {
        const result = await fn(client);
        nested ? db.exec(`RELEASE SAVEPOINT ${savepoint}`) : db.exec("COMMIT");
        return result;
      } catch (error) {
        nested ? db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`) : db.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return client;
}
