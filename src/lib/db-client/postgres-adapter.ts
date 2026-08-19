import { Pool, type PoolClient } from "pg";
import type { DbClient, DbParams } from "@/lib/db-client/types";

// Translates this codebase's `?` positional placeholders to Postgres's
// `$1,$2,...`, skipping `?` characters that appear inside a single-quoted
// SQL string literal. Deliberately simple (no escaped-quote handling)
// since no query in this codebase's SQL text uses a literal `?` outside
// of a placeholder.
function toPositional(sql: string): string {
  let i = 0;
  let inString = false;
  let out = "";
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    if (ch === "?" && !inString) {
      out += `$${++i}`;
      continue;
    }
    out += ch;
  }
  return out;
}

type Queryable = { query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> };

function bind(queryable: Queryable): Omit<DbClient, "transaction"> {
  return {
    async get<T>(sql: string, params: DbParams = []) {
      const { rows } = await queryable.query(toPositional(sql), params as unknown[]);
      return rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: DbParams = []) {
      const { rows } = await queryable.query(toPositional(sql), params as unknown[]);
      return rows as T[];
    },
    async run(sql: string, params: DbParams = []) {
      const result = await queryable.query(toPositional(sql), params as unknown[]);
      return { changes: result.rowCount ?? 0 };
    },
  };
}

// Real pg pool against a direct Postgres connection to Supabase — NOT
// @supabase/supabase-js's PostgREST client, which has no general
// multi-statement transaction support. connectionString must be a
// direct/session-pooler connection (SUPABASE_DB_URL), not the
// Transaction-mode PgBouncer pooler, which breaks pg's prepared-statement
// caching.
export function createPostgresDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });
  const base = bind(pool);
  return {
    ...base,
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      const txBase = bind(client);
      const tx: DbClient = {
        ...txBase,
        transaction: () => {
          throw new Error("nested transactions not supported");
        },
      };
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
