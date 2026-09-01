import { Pool, type PoolClient, types } from "pg";
import type { DbClient, DbParams } from "@/lib/db-client/types";
import { dbClientContext } from "@/lib/db-client/context";

// pg's default DATE (oid 1082) parser returns a JS Date object, not the
// "YYYY-MM-DD" string this codebase's SQL text, types (e.g. LearnerRow's
// date_of_birth: string), and validation (learner-profile/validation.ts's
// strict ^\d{4}-\d{2}-\d{2}$ regex) all assume everywhere — SQLite has no
// real date type, so its adapter already returns the stored string as-is.
// Registering this globally on `pg`'s type parser table (not per-Pool) is
// the standard fix; module-level so it applies before any query runs.
types.setTypeParser(1082, (value: string) => value);

// pg's default BIGINT/int8 (oid 20) parser returns a JS string, not a
// number — precision-safe for values that could exceed
// Number.MAX_SAFE_INTEGER, but this schema only ever uses bigint for
// version/sequence counters and paise-denominated money amounts (see
// every `bigint` column across supabase/migrations/*.sql), none of which
// come remotely close to that ceiling, and every one of this codebase's
// SQLite-mirrored columns/types/call sites already assumes a plain JS
// number (SQLite's own `integer` has no such distinction). Confirmed
// live: staff_passkey_credentials.sign_count came back as a string,
// which @simplewebauthn/server's verifyAuthenticationResponse silently
// mishandled as its `counter` input, failing every staff passkey login
// with WEBAUTHN_AUTHENTICATION_INVALID.
types.setTypeParser(20, (value: string) => parseInt(value, 10));

// pg's default JSON/JSONB (oid 114 / 3802) parsers return an already-parsed
// JS value, not the raw text SQLite's TEXT-column adapter returns for the
// same `*_json` columns. Every repo across this codebase reads those
// columns with its own `JSON.parse(row.x_json)` (written against SQLite's
// convention), so on Postgres that becomes `JSON.parse(<object>)` — the
// object coerces to the string "[object Object]" first, which then fails
// to parse. Confirmed live: AR-002 release creation's `toView` crashed with
// exactly `"[object Object]" is not valid JSON` reading back manifest_json
// right after a successful insert. Returning the raw text here (matching
// SQLite) lets every existing call site's own JSON.parse keep working
// unmodified on both backends.
types.setTypeParser(114, (value: string) => value);
types.setTypeParser(3802, (value: string) => value);

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
// Builds the DbClient handed to a transaction() callback, bound to one
// already-open PoolClient. Its own transaction() opens a SAVEPOINT instead
// of a fresh pool.connect() + BEGIN, mirroring sqlite-adapter.ts's
// depth-tracked SAVEPOINT scheme — same semantics, same reason (a
// converted function is free to call resolveDbClient().transaction() while
// already running inside an outer converted function's own transaction()).
// `depthRef` is shared (by reference) across every tx object derived from
// the same PoolClient, so depth is tracked per physical transaction, not
// per DbClient instance.
function makeTransactionClient(client: PoolClient, depthRef: { depth: number }): DbClient {
  const txBase = bind(client);
  const tx: DbClient = {
    ...txBase,
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      depthRef.depth += 1;
      const savepoint = `dbc_sp_${depthRef.depth}`;
      try {
        await client.query(`SAVEPOINT ${savepoint}`);
        const result = await dbClientContext.run(tx, () => fn(tx));
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        depthRef.depth -= 1;
      }
    },
  };
  return tx;
}

export function createPostgresDbClient(connectionString: string): DbClient {
  // Without an explicit timeout, a connection that can't complete (wrong
  // host/port, unreachable network path) hangs indefinitely instead of
  // failing fast — this bit us as a Next.js build-time static-generation
  // timeout when `/` tried to reach Postgres during `next build`.
  //
  // 25s (not 10s): verified live that the very first connection a cold-
  // started Vercel Lambda opens to Supabase's Supavisor Session pooler
  // (cross-region: Vercel's default region <-> ap-southeast-1) reliably
  // takes just over 10s — pg-pool's own connectionTimeoutMillis firing at
  // 10s was aborting a handshake that was still in progress, which then
  // reports as "Connection terminated unexpectedly" from the socket layer
  // (not an actual reject — the same connection string connects in well
  // under a second from a non-Vercel network). Stay under layout.tsx's
  // maxDuration=30 so the platform doesn't kill the function first.
  //
  // ssl: Supabase's documented guidance for serverless/edge platforms
  // that don't ship the pooler's CA bundle.
  // max: pg's own default is 10. resolveDbClient() caches one Pool per
  // warm Lambda instance (index.ts), but Vercel runs many instances
  // concurrently, each with its own Pool -- at the default max, as few as
  // 2 concurrently-warm instances (2*10=20) exceed Supabase's Session-mode
  // pooler cap. Confirmed live: "EMAXCONNSESSION ... max clients are
  // limited to pool_size: 15" on /account under ordinary concurrent
  // traffic. A low per-instance cap keeps many concurrent instances well
  // under the shared server-side limit; a single request rarely needs
  // more than 1-2 connections at once (transaction() holds exactly one).
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 25_000,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
  });
  const base = bind(pool);
  return {
    ...base,
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      // A stale top-level client reference (captured via resolveDbClient()
      // before any transaction started, then reused deeper in the same
      // call stack after a transaction opened) must not open a second,
      // unrelated pool connection — route it through the active
      // transaction's own nested-transaction handler instead. The common
      // case (an unrelated function calling resolveDbClient().transaction()
      // fresh) never reaches this branch at all, since resolveDbClient()
      // itself already returns the active tx client directly once
      // dbClientContext is set — so if we're here AND dbClientContext has
      // an active store, it can only be via a stale captured reference.
      const active = dbClientContext.getStore();
      if (active) return active.transaction(fn);

      const client: PoolClient = await pool.connect();
      const depthRef = { depth: 0 };
      const tx = makeTransactionClient(client, depthRef);
      try {
        await client.query("BEGIN");
        const result = await dbClientContext.run(tx, () => fn(tx));
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
