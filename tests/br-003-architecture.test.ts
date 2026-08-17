import fs from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = fs.readFileSync("Requirements/BR-003-RELEASE-SAFETY-RUNBOOK.md", "utf8");
const workflow = fs.readFileSync(".github/workflows/release-safety-checks.yml", "utf8");
const rollbackServiceSource = fs.readFileSync("src/lib/deployment-rollback/service.ts", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

describe("BR-003 runbook — required policy statements", () => {
  it("indexes every existing AR-002 mechanism by exact function/file name rather than re-describing it loosely", () => {
    expect(runbook).toContain("ReleaseGateResults");
    expect(runbook).toContain("deployToStaging");
    expect(runbook).toContain("assertReleaseSchemaCompatibility");
    expect(runbook).toContain("rollbackProduction");
    expect(runbook).toContain("sweepReleaseSafetyObservations");
  });

  it("documents the migration remediation policy: tested forward migration first, BR-002 restore reserved for real recovery", () => {
    expect(runbook).toMatch(/tested forward migration/i);
    expect(runbook).toMatch(/BR-002 restore is[\s\S]*reserved for actual recovery/i);
  });

  it("documents canary/blue-green as explicitly out of V1 scope", () => {
    expect(runbook).toMatch(/canary\/blue-green.*(out of|absent)/i);
  });

  it("documents the branch-protection step as a manual, not-yet-done repository configuration action", () => {
    expect(runbook).toMatch(/branch protection/i);
    expect(runbook).toMatch(/has no GitHub branch protection rule today/i);
  });
});

describe("BR-003 CI workflow", () => {
  it("runs the full test suite and typecheck, not just the narrow architecture subset", () => {
    expect(workflow).toMatch(/npm run typecheck/);
    expect(workflow).toMatch(/npm test\b/);
  });

  it("runs the migration safety checker", () => {
    expect(workflow).toContain("npm run check:migrations");
  });

  it("registers the check:migrations script in package.json", () => {
    expect(packageJson.scripts["check:migrations"]).toBe("node scripts/check-migration-safety.mjs");
  });
});

describe("BR-003 rollback alerting", () => {
  it("routes through AN-003's shared raiseDeduplicatedAlert/resolveDeduplicatedAlert, not a bespoke second alert mechanism", () => {
    expect(rollbackServiceSource).toContain("raiseDeduplicatedAlert");
    expect(rollbackServiceSource).toContain("resolveDeduplicatedAlert");
    expect(rollbackServiceSource).not.toMatch(/insert into platform_alerts/i);
  });
});
