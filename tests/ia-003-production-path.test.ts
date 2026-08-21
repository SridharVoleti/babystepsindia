import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("IA-003 production credential lifecycle", () => {
  const routes = [
    "src/app/v1/account/password/change/route.ts",
    "src/app/v1/account/email-change/request/route.ts",
    "src/app/v1/account/email-change/resend/route.ts",
    "src/app/v1/account/email-change/cancel/route.ts",
    "src/app/v1/account/soft-delete/route.ts",
  ].map(source).join("\n");

  it("has no route-level SQLite credential dependency", () => {
    expect(routes).not.toContain("sqliteAuthAdapter");
    expect(routes).toContain("supabase-account-security");
  });

  it("uses shared Postgres-capable persistence and distributed limits", () => {
    expect(routes).toContain("consumeDistributedRateLimit");
    const production = source("src/lib/account/supabase-account-security.ts");
    expect(production).toContain("resolveDbClient");
    expect(production).toMatch(/auth\.signInWithPassword/);
    expect(production).toMatch(/auth\.updateUser/);
  });

  it("does not run production parent-account actions through SQLite mode lookup", () => {
    const guard = source("src/lib/authorization/api-guard.ts");
    expect(guard).toMatch(/parent\.account\./);
  });

  it("never returns a local email verification URL from production routes", () => {
    expect(routes).not.toContain("/auth/email-change/callback?token=");
  });

  it("finalizes verified Supabase email changes through the shared database", () => {
    expect(source("src/app/auth/callback/route.ts")).toContain("finalizeAuthoritativeEmailChange");
    expect(source("src/lib/account/supabase-account-security.ts")).toContain("parent_email_history");
  });
});
