#!/usr/bin/env node
// Starts a disposable real PostgreSQL (embedded binaries), applies every migration from zero, runs vitest with PG_TEST_URL set, then stops it.
//   npm install --no-save embedded-postgres        (not a project dependency; downloads real PostgreSQL binaries)
//   node scripts/run-with-disposable-postgres.mjs tests/pg
// TLS is disabled for this local database only (SUPABASE_DB_SSL=disable is ignored in production). Everything lives in a temp directory.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let EmbeddedPostgres;
try {
  ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
} catch {
  console.error("BLOCKED_EXTERNAL: run `npm install --no-save embedded-postgres` first (provides real PostgreSQL binaries).");
  process.exit(2);
}

const repo = resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "bsi-pg-"));
const port = 54000 + Math.floor(Math.random() * 900);
const server = new EmbeddedPostgres({ databaseDir: join(dataDir, "data"), user: "postgres", password: "pw", port, persistent: false });
let code = 1;
try {
  await server.initialise();
  await server.start();
  await server.createDatabase("pgtest");
  const url = `postgres://postgres:pw@localhost:${port}/pgtest`;
  const migrations = spawnSync(process.execPath, ["scripts/verify-migrations-postgres.mjs"], { cwd: repo, stdio: "inherit", env: { ...process.env, PG_VERIFY_URL: url } });
  if (migrations.status !== 0) { code = migrations.status ?? 1; throw new Error("migrations failed"); }
  const tests = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], { cwd: repo, stdio: "inherit", shell: true,
    env: { ...process.env, PG_TEST_URL: url, SUPABASE_DB_SSL: "disable" } });
  code = tests.status ?? 1;
} catch (error) {
  if (!String(error.message).includes("migrations failed")) console.error(error);
} finally {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(code);
