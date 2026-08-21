import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";

const source = (path: string) => readFileSync(path, "utf8");

describe("IA-002 production persistence architecture", () => {
  beforeEach(() => useInMemoryDb());

  it("routes parent profile persistence through DbClient rather than the SQLite singleton", () => {
    const repository = source("src/lib/db/parent-profile-repo.ts");
    expect(repository).toContain("resolveDbClient");
    expect(repository).not.toMatch(/\bgetDb\b/);
  });

  it("awaits asynchronous profile persistence at the HTTP boundary", () => {
    const route = source("src/app/v1/parent/profile/route.ts");
    expect(route).toMatch(/await getOnboardingProfile/);
    expect(route).toMatch(/await completeParentOnboarding/);
  });

  it("uses verified Supabase Auth identity when Supabase is configured", () => {
    const guard = source("src/lib/auth/api-guard.ts");
    expect(guard).toContain("getVerifiedSupabaseParentContext");
    expect(guard).toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("persists rate-limit counts so separate callers share one window", async () => {
    const input = { key: "profile-update:parent-1", limit: 2, windowMs: 60_000 };
    expect(await consumeDistributedRateLimit(input)).toBe(true);
    expect(await consumeDistributedRateLimit(input)).toBe(true);
    expect(await consumeDistributedRateLimit(input)).toBe(false);
  });

  it("ships owner-isolation and distributed-rate-limit schema", () => {
    const migration = source("supabase/migrations/0073_ia002_production_path.sql");
    expect(migration).toMatch(/profiles[\s\S]*auth\.uid\(\) = id/i);
    expect(migration).toMatch(/consent_records[\s\S]*auth\.uid\(\) = parent_user_id/i);
    expect(migration).toMatch(/create table[\s\S]*distributed_rate_limits/i);
    expect(migration).toMatch(/force row level security/i);
  });
});
