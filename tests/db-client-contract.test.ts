// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db-client/types";
import { createSqliteDbClient } from "@/lib/db-client/sqlite-adapter";
import { createPostgresDbClient } from "@/lib/db-client/postgres-adapter";
import { resetDbClientForTests } from "@/lib/db-client";
import { useInMemoryDb } from "@/lib/db/test-utils";

// Same contract, both backends — mirrors tests/deployment-provider-
// contract.test.ts's precedent (one shared suite exercised against every
// DbClient implementation). Uses a scratch table created/dropped by the
// suite itself via DbClient.run() (DbClient has no DDL method — run()
// just sends whatever SQL text it's given, which works fine for a single
// CREATE/DROP TABLE statement on both better-sqlite3 and pg).
const TABLE = "db_client_contract_scratch";

function contractSuite(name: string, makeClient: () => DbClient, opts: { skip?: boolean } = {}) {
  (opts.skip ? describe.skip : describe)(`DbClient contract: ${name}`, () => {
    let db: DbClient;

    beforeEach(async () => {
      db = makeClient();
      await db.run(`create table if not exists ${TABLE} (id text primary key, value text not null)`);
    });

    afterEach(async () => {
      await db.run(`drop table if exists ${TABLE}`);
    });

    it("run() inserts and reports changes", async () => {
      const id = randomUUID();
      const result = await db.run(`insert into ${TABLE} (id, value) values (?, ?)`, [id, "first"]);
      expect(result.changes).toBe(1);
    });

    it("get() returns a single row or undefined", async () => {
      const id = randomUUID();
      await db.run(`insert into ${TABLE} (id, value) values (?, ?)`, [id, "hello"]);
      const row = await db.get<{ id: string; value: string }>(`select * from ${TABLE} where id = ?`, [id]);
      expect(row?.value).toBe("hello");
      const missing = await db.get(`select * from ${TABLE} where id = ?`, [randomUUID()]);
      expect(missing).toBeUndefined();
    });

    it("all() returns every matching row", async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      await db.run(`insert into ${TABLE} (id, value) values (?, ?)`, [idA, "a"]);
      await db.run(`insert into ${TABLE} (id, value) values (?, ?)`, [idB, "b"]);
      const rows = await db.all<{ id: string; value: string }>(
        `select * from ${TABLE} where id in (?, ?) order by value`,
        [idA, idB],
      );
      expect(rows.map((r) => r.value)).toEqual(["a", "b"]);
    });

    it("transaction() commits on success", async () => {
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [id, "committed"]);
      });
      const row = await db.get<{ value: string }>(`select value from ${TABLE} where id = ?`, [id]);
      expect(row?.value).toBe("committed");
    });

    it("transaction() rolls back on error", async () => {
      const id = randomUUID();
      await expect(
        db.transaction(async (tx) => {
          await tx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [id, "rolled-back"]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const row = await db.get(`select value from ${TABLE} where id = ?`, [id]);
      expect(row).toBeUndefined();
    });
  });
}

contractSuite("SQLite (better-sqlite3)", () => {
  useInMemoryDb();
  return createSqliteDbClient();
});

// Only runs against a real database when the user has pointed
// SUPABASE_DB_URL at their live Supabase project — skips cleanly
// otherwise (no local Postgres available to test against by default).
contractSuite(
  "Postgres (live Supabase project)",
  () => createPostgresDbClient(process.env.SUPABASE_DB_URL as string),
  { skip: !process.env.SUPABASE_DB_URL },
);

// Real bug found 2026-08-20 auditing this migration for live-Postgres
// safety: postgres-adapter.ts's transaction() used to throw outright on
// any nested transaction() call, but the sanctioned, already-shipped
// migration pattern (e.g. restoreAccountViaGovernance calling
// restoreAccount) relies on a converted function calling ANOTHER converted
// function's own resolveDbClient().transaction() from inside an
// already-open transaction — "just works" on SQLite only because every
// resolveDbClient() call there returns the one singleton connection. This
// exercises the real production shape (resolveDbClient(), not a
// hand-constructed client) against both backends, proving the
// AsyncLocalStorage-based fix (db-client/context.ts) makes a totally
// unrelated function's fresh resolveDbClient().transaction() call
// transparently reuse the active transaction's connection via a SAVEPOINT,
// with correct partial-rollback and full-rollback semantics.
// Preserved so the SQLite variant (which must run without SUPABASE_DB_URL
// set, to prove resolveDbClient() genuinely falls back) doesn't permanently
// clobber it for the Postgres variant declared later in this same file —
// vitest describe blocks all register before any test body runs, but env
// var mutation inside beforeEach happens at run time, in declaration order.
const originalSupabaseDbUrl = process.env.SUPABASE_DB_URL;

function nestedTransactionSuite(name: string, setUrl: () => void, opts: { skip?: boolean } = {}) {
  (opts.skip ? describe.skip : describe)(`DbClient nested transaction() via resolveDbClient(): ${name}`, () => {
    let db: DbClient;

    beforeEach(async () => {
      setUrl();
      resetDbClientForTests();
      const { resolveDbClient } = await import("@/lib/db-client");
      db = resolveDbClient();
      await db.run(`create table if not exists ${TABLE} (id text primary key, value text not null)`);
    });

    afterEach(async () => {
      await db.run(`drop table if exists ${TABLE}`);
      if (originalSupabaseDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
      else process.env.SUPABASE_DB_URL = originalSupabaseDbUrl;
      resetDbClientForTests();
    });

    async function innerWrite(id: string, value: string) {
      const { resolveDbClient } = await import("@/lib/db-client");
      const innerDb = resolveDbClient();
      await innerDb.transaction(async (tx) => {
        await tx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [id, value]);
      });
    }

    it("outer commit persists both the outer write and an unrelated function's nested write", async () => {
      const outerId = randomUUID();
      const innerId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [outerId, "outer"]);
        await innerWrite(innerId, "inner");
      });
      const rows = await db.all<{ id: string }>(`select id from ${TABLE} where id in (?, ?)`, [outerId, innerId]);
      expect(rows).toHaveLength(2);
    });

    it("an inner nested failure rolls back only the inner write, not the outer transaction", async () => {
      const outerId = randomUUID();
      const innerId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [outerId, "outer"]);
        await expect(
          (async () => {
            const { resolveDbClient } = await import("@/lib/db-client");
            const innerDb = resolveDbClient();
            await innerDb.transaction(async (innerTx) => {
              await innerTx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [innerId, "inner"]);
              throw new Error("inner failure");
            });
          })(),
        ).rejects.toThrow("inner failure");
      });
      const outerRow = await db.get(`select id from ${TABLE} where id = ?`, [outerId]);
      const innerRow = await db.get(`select id from ${TABLE} where id = ?`, [innerId]);
      expect(outerRow).toBeDefined();
      expect(innerRow).toBeUndefined();
    });

    it("an outer rollback also discards an already-committed inner savepoint's write", async () => {
      const outerId = randomUUID();
      const innerId = randomUUID();
      await expect(
        db.transaction(async (tx) => {
          await tx.run(`insert into ${TABLE} (id, value) values (?, ?)`, [outerId, "outer"]);
          await innerWrite(innerId, "inner");
          throw new Error("outer failure");
        }),
      ).rejects.toThrow("outer failure");
      const rows = await db.all<{ id: string }>(`select id from ${TABLE} where id in (?, ?)`, [outerId, innerId]);
      expect(rows).toHaveLength(0);
    });
  });
}

nestedTransactionSuite("SQLite (better-sqlite3)", () => {
  delete process.env.SUPABASE_DB_URL;
  useInMemoryDb();
});

nestedTransactionSuite(
  "Postgres (live Supabase project)",
  () => {
    // useInMemoryDb() isn't relevant here (Postgres ignores SQLITE_DB_PATH);
    // SUPABASE_DB_URL must already be set in the environment for this to run.
  },
  { skip: !process.env.SUPABASE_DB_URL },
);
