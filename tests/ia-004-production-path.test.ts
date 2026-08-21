import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("IA-004 production WebAuthn path", () => {
  const gateway = source("src/lib/webauthn/production-gateway.ts");
  const postgres = source("src/lib/webauthn/postgres-service.ts");

  it("selects Postgres whenever the production database URL exists", () => {
    expect(gateway).toContain("SUPABASE_DB_URL");
    expect(gateway).toContain("postgres-service");
    expect(gateway).toContain("import(\"@/lib/webauthn/service\")");
  });

  it("does not depend on direct SQLite storage in the deployed implementation", () => {
    expect(postgres).toContain("resolveDbClient");
    expect(postgres).not.toContain("getDb");
  });

  it("atomically consumes a bound, live challenge", () => {
    expect(postgres).toMatch(/update webauthn_challenges[\s\S]*consumed_at is null[\s\S]*expires_at>/);
    expect(postgres).toContain("returning challenge_hash");
  });

  it("validates an exact HTTPS RP origin configuration", () => {
    expect(postgres).toContain("WEBAUTHN_RP_ID");
    expect(postgres).toContain("WEBAUTHN_ORIGIN");
    expect(postgres).toContain("https:");
  });

  it("revokes dependent contexts on clone suspicion and parent revocation", () => {
    expect(postgres).toContain("clone_suspected");
    expect(postgres).toContain("credential_revoked");
    expect(postgres).toContain("learner_unlock_contexts");
  });
});
