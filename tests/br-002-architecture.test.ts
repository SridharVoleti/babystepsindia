import fs from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = fs.readFileSync("Requirements/BR-002-RESTORE-RUNBOOK.md", "utf8");
const serviceSource = fs.readFileSync("src/lib/disaster-recovery/service.ts", "utf8");

describe("BR-002 runbook — required policy statements", () => {
  it("names PC-004's replayDeletionObligations as the restore-time deletion replay step", () => {
    expect(runbook).toContain("replayDeletionObligations");
  });

  it("names BI-002's reconcileBilling as the billing-reconciliation step", () => {
    expect(runbook).toContain("reconcileBilling");
  });

  it("names AN-001/AN-002's rebuild functions as the derivable-state-reconstruction step", () => {
    expect(runbook).toMatch(/runDailyAggregation/);
    expect(runbook).toMatch(/syncMonitoringSnapshots/);
  });

  it("documents the Super Admin (all 4 roles) restore-authority gate", () => {
    expect(runbook).toMatch(/requireSuperAdminApi/);
  });

  it("does not claim a drill has actually been run yet", () => {
    expect(runbook).toMatch(/no drill has ever actually been run/i);
  });
});

describe("BR-002 frozen architecture", () => {
  it("the evidence-ledger service never mutates a source-of-truth table — only its own record", () => {
    const protectedTables = [
      "staff_accounts", "subscriptions", "learners", "profiles", "billing_job_runs", "payments",
    ];
    for (const table of protectedTables) {
      expect(serviceSource).not.toMatch(new RegExp(`(update|delete from|insert into)\\s+${table}\\b`, "i"));
    }
  });

  it("only ever writes to its own table plus the shared governance receipt/audit tables", () => {
    const writes = serviceSource.match(/(update|delete from|insert into)\s+(\w+)/gi) ?? [];
    const allowed = /disaster_recovery_test_records$/;
    for (const write of writes) {
      expect(write).toMatch(allowed);
    }
  });

  it("never issues a live network/HTTP call — evidence recording only, no orchestration of a real restore", () => {
    expect(serviceSource).not.toMatch(/fetch\(|https?:\/\//);
  });
});
