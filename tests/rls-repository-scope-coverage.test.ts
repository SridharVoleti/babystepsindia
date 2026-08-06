import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  repositoryScopeRegistry,
  supabaseTableAccess,
} from "@/lib/db/access-boundaries";

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

    for (const table of createdTables) {
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
      .filter((file) => fs.readFileSync(file, "utf8").includes("getDb("))
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .filter((file) => file !== "src/lib/db/client.ts")
      .sort();

    expect(Object.keys(repositoryScopeRegistry).sort()).toEqual(dataModules);
  });
});
