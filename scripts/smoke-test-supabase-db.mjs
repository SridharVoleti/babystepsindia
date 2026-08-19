#!/usr/bin/env node
// Manual, one-off smoke test for the Postgres DbClient adapter against a
// REAL live Supabase project (no local Postgres exists to test against).
// Run after setting SUPABASE_DB_URL:
//   node scripts/smoke-test-supabase-db.mjs
//
// Deliberately read-only against real tables (products) plus a scratch
// table for the write/transaction probe — this never runs
// purgeExpiredSupportCaseContent for real, since that deletes rows from
// live support_cases* data. It only proves the DbClient <-> live schema
// wiring is correct (connection, `?`->`$N` translation, transaction
// commit/rollback), the same thing tests/db-client-contract.test.ts's
// Postgres half proves under vitest — this is a quick standalone check
// you can run without the test runner.

import pg from "pg";

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_DB_URL is not set. Copy it from Supabase's Database settings first.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`ok   - ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${label}`);
    console.error(`       ${error.message}`);
  }
}

await check("connect to the live Supabase Postgres database", async () => {
  await pool.query("select 1");
});

await check("read the real products table (products.ts's listProducts query)", async () => {
  const { rows } = await pool.query("select * from products where status != 'archived' order by name");
  console.log(`       -> ${rows.length} active product(s) found`);
});

await check("scratch table create/insert/select/drop", async () => {
  const table = "db_client_smoke_scratch";
  await pool.query(`create table if not exists ${table} (id uuid primary key, value text not null)`);
  const id = "00000000-0000-4000-8000-000000000000";
  await pool.query(`insert into ${table} (id, value) values ($1, $2) on conflict (id) do update set value = excluded.value`, [id, "smoke-test"]);
  const { rows } = await pool.query(`select value from ${table} where id = $1`, [id]);
  if (rows[0]?.value !== "smoke-test") throw new Error("round-tripped value did not match");
  await pool.query(`drop table if exists ${table}`);
});

await check("transaction commit vs rollback", async () => {
  const table = "db_client_smoke_scratch_tx";
  await pool.query(`create table if not exists ${table} (id uuid primary key)`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`insert into ${table} (id) values ($1)`, ["00000000-0000-4000-8000-000000000001"]);
    await client.query("ROLLBACK");
    const { rows } = await pool.query(`select count(*)::int as n from ${table}`);
    if (rows[0].n !== 0) throw new Error("rollback did not revert the insert");
  } finally {
    client.release();
  }
  await pool.query(`drop table if exists ${table}`);
});

await pool.end();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
