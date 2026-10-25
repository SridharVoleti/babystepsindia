#!/usr/bin/env node
// Applies every supabase/migrations/*.sql, in order, from an EMPTY PostgreSQL database and fails on the first real error.
//   PG_VERIFY_URL=postgres://user:pass@host:port/dbname node scripts/verify-migrations-postgres.mjs
// Use a disposable database only (it creates roles and an `auth` schema). A bare Postgres lacks what Supabase provides before user
// migrations run, so minimal stand-ins are created first: the anon/authenticated/service_role roles and auth.users / auth.uid() / auth.role().
// Needs the btree_gist and pgcrypto contrib extensions (present on Supabase and in standard Postgres distributions).
// Exit codes: 0 = all applied, 1 = one or more migrations failed, 2 = PG_VERIFY_URL not set (BLOCKED_EXTERNAL).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const url = process.env.PG_VERIFY_URL;
if (!url) {
  console.error("BLOCKED_EXTERNAL: set PG_VERIFY_URL to a disposable, empty PostgreSQL database.");
  process.exit(2);
}

const dir = resolve(import.meta.dirname, "..", "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  create extension if not exists btree_gist;
  create extension if not exists pgcrypto;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, encrypted_password text,
    email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'anon'::text $$;
`);

let applied = 0;
const failures = [];
for (const file of files) {
  try {
    await client.query(readFileSync(join(dir, file), "utf8"));
    applied += 1;
  } catch (error) {
    failures.push(`${file}: ${String(error.message).split("\n")[0]}`);
    try { await client.query("rollback"); } catch { /* no open transaction */ }
  }
}
const serverVersion = (await client.query("show server_version")).rows[0].server_version;
await client.end();
console.log(`PostgreSQL ${serverVersion}: applied ${applied}/${files.length} migrations from zero`);
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
