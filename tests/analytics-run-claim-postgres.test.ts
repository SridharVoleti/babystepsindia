import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AN-001 distributed Postgres run claim (AT-AN-001-10)", () => {
  const migration = readFileSync("supabase/migrations/0029_an001_atomic_daily_run_claim.sql", "utf8").toLowerCase();

  it("provides one database-owned claim function with conflict-safe insertion", () => {
    expect(migration).toContain("create or replace function claim_analytics_daily_run");
    expect(migration).toContain("on conflict (activity_date) do nothing");
    expect(migration).toContain("for update");
  });

  it("reclaims only failed rows and increments their version atomically", () => {
    expect(migration).toMatch(/status\s*=\s*'running'/);
    expect(migration).toMatch(/run_version\s*=\s*run_version\s*\+\s*1/);
    expect(migration).toMatch(/status\s*=\s*'failed'/);
    expect(migration).toContain("revoke all on function claim_analytics_daily_run");
  });
});
