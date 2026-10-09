import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Fresh-install defects found by applying every migration from zero to a real multi-connection PostgreSQL (see scripts/verify-migrations-postgres.mjs).
// These static guards keep the specific defects from returning even where no Postgres is available.
const read = (name: string) => readFileSync(`supabase/migrations/${name}`, "utf8");

describe("migrations apply to a fresh PostgreSQL", () => {
  it("0044 does not call min() on a uuid column (PostgreSQL has no min(uuid))", () => {
    const sql = read("0044_bi001_subscription_assignment.sql");
    expect(sql).not.toMatch(/min\(l\.id\)/);
    expect(sql).toMatch(/min\(l\.id::text\)::uuid/);
  });

  it("0070 declares learner_id with the same type as learners.id (uuid) so the foreign key can be created", () => {
    expect(read("0011_lp001_learners.sql")).toMatch(/create table learners \(\s*id uuid primary key/);
    expect(read("0070_pc004_data_erasure_receipts.sql")).toMatch(/learner_id uuid not null references learners\(id\)/);
  });

  it("0079 recreates the price-immutability trigger only where its function exists (it is defined by no migration, only on the live database)", () => {
    const sql = read("0079_billing_boolean_dialect_fix.sql");
    expect(sql).toMatch(/pg_proc[\s\S]*prevent_product_price_version_change[\s\S]*create trigger product_prices_version_immutable/);
    expect(sql).not.toMatch(/^create trigger product_prices_version_immutable/m);                   // not unconditional at top level
  });

  it("the Postgres verification script and its documentation exist", () => {
    expect(readFileSync("scripts/verify-migrations-postgres.mjs", "utf8")).toMatch(/PG_VERIFY_URL/);
    expect(readFileSync("README.md", "utf8")).toMatch(/verify-migrations-postgres/);
  });
});

describe("production SQL is portable to PostgreSQL", () => {
  it("no service SQL uses SQLite-only 'insert or ignore/replace' (src/lib/db/client.ts is the SQLite bootstrap and is exempt)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = `${dir}/${f}`;
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts") || p.endsWith("src/lib/db/client.ts")) continue;
        if (/insert or (ignore|replace) into/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk("src/lib");
    expect(hits).toEqual([]);
  });

  it("learning_reminder_email_enabled is converted to integer like the other 1/0-compared columns (precedent: 0074, 0079)", () => {
    const sql = read("0086_prg041_reminder_preference_integer.sql");
    expect(sql).toMatch(/alter column learning_reminder_email_enabled type integer using \(case when learning_reminder_email_enabled then 1 else 0 end\)/);
    expect(sql).toMatch(/set default 1/);
  });
});

describe("approved app icons work on PostgreSQL (PRG-042)", () => {
  it("0087 converts approved_app_icons.id to text and seeds the same icons the SQLite bootstrap uses", () => {
    const sql = read("0087_prg042_approved_app_icons_text_ids.sql");
    expect(sql).toMatch(/alter column id type text using id::text/);
    const bootstrap = readFileSync("src/lib/db/client.ts", "utf8");
    for (const icon of ["icon-chess-piece", "icon-abacus", "icon-open-book"]) {
      expect(bootstrap).toContain(`"${icon}"`);
      expect(sql).toContain(`'${icon}'`);
    }
  });
});
