import fs from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = fs.readFileSync("Requirements/BR-004-DISASTER-RECOVERY-DEPENDENCY.md", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");

describe("BR-004 runbook — required policy statements", () => {
  it("documents Vercel and Supabase as the platform disaster-recovery dependency", () => {
    expect(runbook).toMatch(/vercel/i);
    expect(runbook).toMatch(/supabase/i);
  });

  it("states no separate Babysteps-specific DR infrastructure is introduced", () => {
    expect(runbook).toMatch(/no[\s\S]*disaster-recovery infrastructure/i);
  });

  it("states no duplicate privileged data copy exists", () => {
    expect(runbook).toMatch(/no duplicate privileged (data )?copy|no duplicate privileged copy/i);
  });

  it("names provider status pages as the incident source of truth", () => {
    expect(runbook).toMatch(/vercel-status\.com/);
    expect(runbook).toMatch(/status\.supabase\.com/);
  });

  it("documents ownership/escalation responsibility for a provider-wide incident", () => {
    expect(runbook).toMatch(/escalation/i);
  });

  it("names the applicable BR-002 and BR-003 post-recovery steps by function name", () => {
    expect(runbook).toContain("replayDeletionObligations");
    expect(runbook).toContain("reconcileBilling");
    expect(runbook).toContain("sweepReleaseSafetyObservations");
    expect(runbook).toContain("raiseDeduplicatedAlert");
  });

  it("explains why BR-002's evidence ledger is not reused for a provider incident, rather than silently reusing it", () => {
    expect(runbook).toMatch(/disaster_recovery_test_records/);
    expect(runbook).toMatch(/misrepresent/i);
  });
});

describe("BR-004 frozen architecture", () => {
  it("no custom disaster-recovery/backup tooling exists anywhere in package.json (same check as BR-001, re-confirmed)", () => {
    expect(packageJson).not.toMatch(/pg_dump|pg_restore|point-in-time|litestream/i);
  });

  it("introduces no new OPERATION_CHANGE_TYPES entry — this requirement is documentation, not a new gated mutation", () => {
    const contracts = fs.readFileSync("src/lib/operations-admin/contracts.ts", "utf8");
    expect(contracts).not.toMatch(/disaster|provider_recovery/i);
  });
});
