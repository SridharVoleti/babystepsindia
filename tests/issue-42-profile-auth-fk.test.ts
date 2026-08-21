import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("issue #42 profiles Auth identity foreign key", () => {
  const sql = readFileSync("supabase/migrations/0074_profiles_auth_user_fk.sql", "utf8");

  it("drops only a profiles.id foreign key that targets public.users", () => {
    expect(sql).toMatch(/confrelid\s*=\s*'public\.users'::regclass/i);
    expect(sql).toMatch(/drop constraint/i);
  });

  it("fails closed when a profile has no canonical Auth user", () => {
    expect(sql).toMatch(/not exists\s*\(select 1 from auth\.users/i);
    expect(sql).toMatch(/raise exception/i);
  });

  it("idempotently enforces auth.users with explicit cascade semantics", () => {
    expect(sql).toMatch(/references auth\.users\s*\(id\)\s*on delete cascade/i);
    expect(sql).toMatch(/confrelid\s*=\s*'auth\.users'::regclass/i);
  });
});
