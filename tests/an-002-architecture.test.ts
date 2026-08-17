import fs from "node:fs";
import { describe, expect, it } from "vitest";

const serviceSource = fs.readFileSync("src/lib/monitoring/service.ts", "utf8");

const SOURCE_JOB_TABLES = [
  "billing_job_runs", "entitlement_lifecycle_job_runs", "notification_delivery_runs",
  "notification_reconcile_runs", "progress_integrity_sweep_runs",
];

describe("AN-002 frozen architecture", () => {
  it("AC4: never writes to any source-domain job-run table — read-only against every registered source", () => {
    for (const table of SOURCE_JOB_TABLES) {
      expect(serviceSource).not.toMatch(new RegExp(`(update|delete from|insert into)\\s+${table}\\b`, "i"));
    }
  });

  it("never mutates billing/subscription/access/session/progress truth tables directly", () => {
    const protectedTables = [
      "subscriptions", "learner_app_effective_entitlements", "learner_sessions", "learner_app_progress", "payments",
    ];
    for (const table of protectedTables) {
      expect(serviceSource).not.toMatch(new RegExp(`(update|delete from|insert into)\\s+${table}\\b`, "i"));
    }
  });

  it("AC5: no continuous synthetic app probe / polling timer is defined in this module", () => {
    expect(serviceSource).not.toMatch(/setInterval|setTimeout|cron|synthetic.?probe/i);
  });

  it("no raw result_json/payload column from any source table is ever selected or copied", () => {
    expect(serviceSource).not.toMatch(/result_json/i);
  });

  it("no learner-identifying field (learner_id, display_name) is ever selected from a source table", () => {
    expect(serviceSource).not.toMatch(/learner_id|display_name/i);
  });
});
