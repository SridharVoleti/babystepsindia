import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  repositoryScopeRegistry,
  supabaseTableAccess,
} from "@/lib/db/access-boundaries";
import { RETIRED_TABLES } from "@/lib/privacy/data-catalog";

const root = process.cwd();
const migrationDir = path.join(root, "supabase", "migrations");

function migrationSql(): string {
  return fs
    .readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => fs.readFileSync(path.join(migrationDir, name), "utf8"))
    .join("\n")
    .replace(/^\s*--.*$/gm, "");
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  });
}

describe("database access boundaries", () => {
  const sql = migrationSql();
  const createdTables = [
    ...sql.matchAll(/^create table(?: if not exists)?\s+([a-z0-9_]+)/gim),
  ].map((match) => match[1]);

  it("classifies every Supabase table and enables and forces RLS", () => {
    expect(Object.keys(supabaseTableAccess).sort()).toEqual(
      [...new Set(createdTables)].sort(),
    );

    // RETIRED_TABLES (src/lib/privacy/data-catalog.ts) are tables a later
    // migration `drop table`s outright (e.g. consent_acceptances, dropped
    // by 0009 in favor of consent_records) — kept in supabaseTableAccess
    // for historical/audit classification, same as data-catalog.ts's own
    // precedent, but they never have live enable/force RLS statements to
    // match since they no longer exist in the final schema.
    for (const table of createdTables) {
      if (RETIRED_TABLES.has(table)) continue;
      expect(sql).toMatch(new RegExp(`alter table ${table} enable row level security`, "i"));
      expect(sql).toMatch(new RegExp(`alter table ${table} force row level security`, "i"));
    }
  });

  it("keeps server-only tables unreachable through PostgREST RLS policies", () => {
    const policyTables = new Set(
      [...sql.matchAll(/create policy[\s\S]*?\bon\s+([a-z0-9_]+)/gi)].map(
        (match) => match[1],
      ),
    );
    for (const [table, access] of Object.entries(supabaseTableAccess)) {
      expect(policyTables.has(table), `${table} policy boundary`).toBe(
        access !== "server_only",
      );
    }
  });

  it("classifies every module that opens the database", () => {
    const dataModules = sourceFiles(path.join(root, "src", "lib"))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        // resolveDbClient( is the db-client-abstraction equivalent of a
        // getDb( call site — files converted to the async DbClient
        // interface (src/lib/db-client) drop the literal getDb( token,
        // so both are matched here to keep them discovered.
        return source.includes("getDb(") || source.includes("resolveDbClient(");
      })
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .filter((file) => file !== "src/lib/db/client.ts")
      // Infrastructure, not a repository: sqlite-adapter.ts calls getDb()
      // internally to share the singleton, but src/lib/db-client itself
      // has no independent repository scope of its own.
      .filter((file) => !file.startsWith("src/lib/db-client/"))
      .sort();

    expect(Object.keys(repositoryScopeRegistry).sort()).toEqual(dataModules);
  });
});
