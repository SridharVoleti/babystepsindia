import { getDb } from "@/lib/db/client";
import type { DbClient, DbParams } from "@/lib/db-client/types";
import { dbClientContext } from "@/lib/db-client/context";

// Wraps the existing, unchanged getDb() singleton in the async DbClient
// shape — behavior is identical to every one of the ~110 files still
// calling getDb() directly; this only exists so converted repository
// files can be written once against DbClient and swap backends via
// resolveDbClient() rather than forking their query code per-backend.
export function createSqliteDbClient(): DbClient {
  const db = getDb();
  let transactionTail: Promise<void> = Promise.resolve();
  const sqliteParams = (params: DbParams) => params.map((value) =>
    typeof value === "boolean" ? (value ? 1 : 0) : value,
  );

  const get = <T,>(sql: string, params: DbParams = []) =>
    Promise.resolve(db.prepare(sql).get(...sqliteParams(params)) as T | undefined);
  const all = <T,>(sql: string, params: DbParams = []) =>
    Promise.resolve(db.prepare(sql).all(...sqliteParams(params)) as T[]);
  const run = (sql: string, params: DbParams = []) =>
    Promise.resolve({ changes: db.prepare(sql).run(...sqliteParams(params)).changes });

  const makeTransactionClient = (depthRef: { depth: number }): DbClient => ({
    get,
    all,
    run,
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      depthRef.depth += 1;
      const savepoint = `dbc_sp_${depthRef.depth}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const tx = makeTransactionClient(depthRef);
        const result = await dbClientContext.run(tx, () => fn(tx));
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        depthRef.depth -= 1;
      }
    },
  });
  const client: DbClient = {
    get, all, run,
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      const active = dbClientContext.getStore();
      if (active) return active.transaction(fn);
      let release!: () => void;
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const tx = makeTransactionClient({ depth: 0 });
      db.exec("BEGIN");
      try {
        const result = await dbClientContext.run(tx, () => fn(tx));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        release();
      }
    },
  };
  return client;
}
