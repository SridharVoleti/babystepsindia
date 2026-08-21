import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("LP-001 production certification", () => {
  it("fails closed instead of selecting SQLite for a Supabase deployment without Postgres", () => {
    const gateway = source("src/lib/learner-profile/production-gateway.ts");
    expect(gateway).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(gateway).toContain("SUPABASE_DB_URL");
    expect(gateway).toContain("LP001_POSTGRES_NOT_CONFIGURED");
  });

  it("keeps owner identity server-derived and all production writes transactional", () => {
    const service = source("src/lib/learner-profile/postgres-service.ts");
    expect(service).toContain("resolveDbClient");
    expect(service).not.toContain("getDb");
    expect(service).toMatch(/transaction\(async/);
    expect(service).toContain("owner_parent_id");
  });
});
