// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db-client/types";
import { createSqliteDbClient } from "@/lib/db-client/sqlite-adapter";
import { createPostgresDbClient } from "@/lib/db-client/postgres-adapter";
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
