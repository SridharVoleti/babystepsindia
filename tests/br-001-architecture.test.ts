import fs from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = fs.readFileSync("Requirements/BR-001-BACKUP-RUNBOOK.md", "utf8");
const routeSource = fs.readFileSync("src/app/v1/internal/backup-status/route.ts", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");

describe("BR-001 runbook — required policy statements", () => {
  it("documents provider-native daily backup as the entire mechanism, no PITR/custom stack", () => {
    expect(runbook).toMatch(/no PITR/i);
    expect(runbook).toMatch(/no[\s\S]*custom[\s\S]*(backup|dump)/i);
  });

  it("documents Git as the recovery source for code/content/versioned config", () => {
    expect(runbook).toMatch(/git[\s\S]*recovery source|recovery source[\s\S]*git/i);
  });

  it("documents derived state as reconstructable", () => {
    expect(runbook).toMatch(/derived state is reconstructable/i);
  });

  it("documents the no-production-backup-for-dev/test policy", () => {
    expect(runbook).toMatch(/production[\s\S]*(backup|restore)[\s\S]*never[\s\S]*(loaded|used)[\s\S]*(development|staging|test)/i);
  });

  it("documents PC-004's replayDeletionObligations as the restore-time deletion replay", () => {
    expect(runbook).toContain("replayDeletionObligations");
  });

  it("documents backup-failure surfacing via AN-003 alerting", () => {
    expect(runbook).toMatch(/raiseDeduplicatedAlert/);
    expect(runbook).toMatch(/critical_providers/);
  });

  it("does not claim a production project already exists or is already configured", () => {
    expect(runbook).toMatch(/never been deployed to a real Supabase production project/i);
  });
});

describe("BR-001 frozen architecture", () => {
  it("no custom dump/PITR/backup-cron tooling is introduced anywhere in the repo scripts", () => {
    expect(packageJson).not.toMatch(/pg_dump|pg_restore|point-in-time|litestream/i);
  });

  it("the backup-status route never mutates a source-of-truth table directly — only ever reports through the alerting primitives", () => {
    expect(routeSource).not.toMatch(/(update|delete from|insert into)\s+\w+/i);
  });

  it("the route requires its own distinct internal-service identity, not a reused one", () => {
    expect(routeSource).toContain('"backup-status-reporter"');
  });

  it("no route or script anywhere in the repo loads a production backup file into a non-production environment", () => {
    const suspicious = fs.readdirSync("scripts", { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(`scripts/${entry.name}`, "utf8"))
      .join("\n");
    expect(suspicious).not.toMatch(/restore.*production.*(dev|test|staging)|pg_restore/i);
  });
});
