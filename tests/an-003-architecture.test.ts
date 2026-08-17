import fs from "node:fs";
import { describe, expect, it } from "vitest";

const alertingSource = fs.readFileSync("src/lib/monitoring/alerting.ts", "utf8");

describe("AN-003 frozen architecture", () => {
  it("closure criterion 'alerting never mutates business state': never writes to a billing/access/session/progress/subscription truth table", () => {
    const protectedTables = [
      "subscriptions", "learner_app_effective_entitlements", "learner_sessions", "learner_app_progress",
      "payments", "billing_job_runs", "entitlement_lifecycle_job_runs",
    ];
    for (const table of protectedTables) {
      expect(alertingSource).not.toMatch(new RegExp(`(update|delete from|insert into)\\s+${table}\\b`, "i"));
    }
  });

  it("only ever writes to platform_alerts", () => {
    const writes = alertingSource.match(/(update|delete from|insert into)\s+(\w+)/gi) ?? [];
    for (const write of writes) {
      expect(write.toLowerCase()).toMatch(/platform_alerts$/);
    }
  });

  it("safe-diagnostics-only: no raw result_json/payload column is ever folded into alert metadata", () => {
    expect(alertingSource).not.toMatch(/result_json/i);
  });

  it("no learner-identifying field (learner_id, display_name) is ever selected or embedded in an alert", () => {
    expect(alertingSource).not.toMatch(/learner_id|display_name/i);
  });

  it("no continuous polling timer is defined in this module — escalation runs only when invoked from the sync route", () => {
    expect(alertingSource).not.toMatch(/setInterval|setTimeout|cron/i);
  });

  it("all 9 Frozen Expectation capability families are represented", () => {
    const families = [
      "billing", "entitlement_access", "progress", "notification", "scheduled_processing",
      "privacy_deletion", "app_platform_contracts", "data_integrity", "critical_providers",
    ];
    for (const family of families) {
      expect(alertingSource).toContain(`"${family}"`);
    }
  });
});
