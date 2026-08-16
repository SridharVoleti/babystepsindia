import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { supabaseTableAccess } from "@/lib/db/access-boundaries";
import {
  AMBIGUOUS_IDENTIFIER_EXEMPTIONS, DIRECT_IDENTIFIER_FIELD_CATALOG, IDENTIFIER_COLUMN_NAMES,
  PROHIBITED_COLUMN_PATTERNS, RETIRED_TABLES, TABLE_PERSONAL_DATA_CLASSIFICATION, type PersonalDataTier,
} from "@/lib/privacy/data-catalog";

// Comments are stripped before parsing — a prose "--" comment can contain
// a literal semicolon (e.g. "profile exists before onboarding; application
// rules..." on the `profiles` table), which would otherwise terminate the
// naive [^;]* body match early and silently drop that table.
const schemaSource = fs.readFileSync("src/lib/db/schema.sql", "utf8").replace(/--[^\n]*/g, "");

function liveTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const tableRegex = /create table if not exists (\w+) \(([^;]*)\);/g;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(schemaSource))) {
    const [, name, body] = match;
    const columns = [...body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s+(text|integer|real|blob)\b/gm)].map((c) => c[1]);
    tables.set(name, columns);
  }
  return tables;
}

// Same heuristic the catalog itself was hand-classified with (rule 8:
// "fail closed for unapproved fields") — re-derived from the LIVE schema
// on every run, so a new/renamed identifier-shaped column on any table
// fails this test immediately rather than silently shipping uncatalogued.
function classify(table: string, columns: string[]): PersonalDataTier {
  const identifierHits = columns.filter((c) =>
    IDENTIFIER_COLUMN_NAMES.has(c) && !AMBIGUOUS_IDENTIFIER_EXEMPTIONS.has(`${table}.${c}`));
  if (identifierHits.length > 0) return "direct_identifier";
  const referencesAPerson = columns.some((c) =>
    /_id$/.test(c) && /(learner|parent|staff|admin|purchaser|user)/.test(c));
  return referencesAPerson ? "pseudonymous_derived" : "no_personal_data";
}

describe("PC-001 Data Catalog — every table classified, fails closed on drift", () => {
  it("AC1: every live table has a catalog entry — a brand-new table with no entry fails this test", () => {
    const missing = [...liveTables().keys()].filter((table) => !(table in TABLE_PERSONAL_DATA_CLASSIFICATION));
    expect(missing).toEqual([]);
  });

  it("AC2: every catalog entry's declared tier matches what its live columns actually derive to, or is manually upgraded (never silently downgraded)", () => {
    const drift: string[] = [];
    for (const [table, columns] of liveTables()) {
      const declared = TABLE_PERSONAL_DATA_CLASSIFICATION[table];
      const derived = classify(table, columns);
      // A table may be declared MORE cautious than the mechanical
      // derivation (e.g. restricted_child_data is a manual upgrade from
      // direct_identifier for `learners`) but never less — a column that
      // mechanically derives to direct_identifier can't be declared
      // pseudonymous/no_personal_data in the catalog.
      const rank: Record<PersonalDataTier, number> = {
        no_personal_data: 0, pseudonymous_derived: 1, direct_identifier: 2, restricted_child_data: 2,
      };
      if (rank[declared] < rank[derived]) drift.push(`${table}: declared ${declared}, derived ${derived}`);
    }
    expect(drift).toEqual([]);
  });

  it("AC3: no catalog entry exists for a table that no longer exists, unless explicitly retired", () => {
    const live = liveTables();
    const stale = Object.keys(TABLE_PERSONAL_DATA_CLASSIFICATION).filter(
      (table) => !live.has(table) && !RETIRED_TABLES.has(table),
    );
    expect(stale).toEqual([]);
  });

  it("every table in the Supabase RLS access registry is also in the personal-data catalog — one canonical table enumeration, not two", () => {
    const missing = Object.keys(supabaseTableAccess).filter((table) => !(table in TABLE_PERSONAL_DATA_CLASSIFICATION));
    expect(missing).toEqual([]);
  });

  it("every direct_identifier/restricted_child_data table has a non-empty field-level purpose+requirement catalog entry", () => {
    const highRisk = Object.entries(TABLE_PERSONAL_DATA_CLASSIFICATION)
      .filter(([, tier]) => tier === "direct_identifier" || tier === "restricted_child_data")
      .map(([table]) => table);
    for (const table of highRisk) {
      expect(DIRECT_IDENTIFIER_FIELD_CATALOG[table]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("`learners` carries no contact identity (no email/phone column) — PC-001's own explicit prohibition", () => {
    const columns = liveTables().get("learners") ?? [];
    expect(columns).not.toContain("email");
    expect(columns).not.toContain("phone_e164");
  });

  it("no advertising identifier, behavioral-profile, session-replay, or device-fingerprint column exists anywhere in the schema", () => {
    const offenders: string[] = [];
    for (const [table, columns] of liveTables()) {
      for (const column of columns) {
        if (PROHIBITED_COLUMN_PATTERNS.some((pattern) => pattern.test(column))) {
          offenders.push(`${table}.${column}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
