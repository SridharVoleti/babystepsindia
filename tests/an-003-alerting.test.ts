// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import {
  escalatePersistentJobFailures, listOpenAlerts, raiseDeduplicatedAlert, resolveDeduplicatedAlert,
} from "@/lib/monitoring/alerting";

beforeEach(() => {
  useInMemoryDb();
});

function seedSnapshot(jobKey: string, status: "completed" | "failed" | "running", runAt: string) {
  getDb().prepare(
    `insert into monitoring_job_snapshots (id,job_key,source_run_key,status,run_at,duration_ms,counts_json,correlation_id,created_at)
     values (?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), jobKey, randomUUID(), status, runAt, null, "{}", null, runAt);
}

describe("AN-003 raiseDeduplicatedAlert / resolveDeduplicatedAlert", () => {
  it("raises a new alert for a fresh alert_type", async () => {
    const result = await raiseDeduplicatedAlert({
      alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical",
      message: "billing_reconcile has failed repeatedly.",
    });
    expect(result.created).toBe(true);
    expect(await listOpenAlerts()).toHaveLength(1);
  });

  it("closure criterion 'one deduplicated alert, not a storm': does not create a second open alert for the same alert_type", async () => {
    await raiseDeduplicatedAlert({ alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical", message: "first" });
    const second = await raiseDeduplicatedAlert({ alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical", message: "second" });
    expect(second.created).toBe(false);
    expect(await listOpenAlerts()).toHaveLength(1);
  });

  it("closure criterion 'recovery closes the alert': resolving marks it resolved and it drops out of the open list", async () => {
    await raiseDeduplicatedAlert({ alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical", message: "down" });
    const result = await resolveDeduplicatedAlert("billing_reconcile_down");
    expect(result.resolved).toBe(1);
    expect(await listOpenAlerts()).toHaveLength(0);
  });

  it("resolving an alert_type with no open alert is a safe no-op", async () => {
    expect((await resolveDeduplicatedAlert("never_raised")).resolved).toBe(0);
  });

  it("a previously resolved alert_type can be raised again as a new open alert", async () => {
    await raiseDeduplicatedAlert({ alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical", message: "down" });
    await resolveDeduplicatedAlert("billing_reconcile_down");
    const result = await raiseDeduplicatedAlert({ alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical", message: "down again" });
    expect(result.created).toBe(true);
    expect(await listOpenAlerts()).toHaveLength(1);
  });

  it("safe-diagnostics-only: safeContext values are carried into metadata verbatim, never a raw payload blob", async () => {
    await raiseDeduplicatedAlert({
      alertType: "billing_reconcile_down", capabilityFamily: "billing", severity: "critical",
      message: "down", safeContext: { jobKey: "billing_reconcile", consecutiveFailures: 3 },
    });
    const alert = (await listOpenAlerts())[0]!;
    expect(JSON.parse(alert.metadata!)).toMatchObject({ jobKey: "billing_reconcile", consecutiveFailures: 3, severity: "critical", capabilityFamily: "billing" });
  });
});

describe("AN-003 escalatePersistentJobFailures (scheduled_processing capability family)", () => {
  it("does not escalate on a single transient failure", async () => {
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:00:00.000Z");
    const result = await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:05:00.000Z"));
    expect(result.escalated).toBe(false);
    expect(await listOpenAlerts()).toHaveLength(0);
  });

  it("closure criterion 'recoverable failures retry first, never alert on the first failure': escalates only after 3 consecutive failed runs", async () => {
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:00:00.000Z");
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:05:00.000Z");
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:10:00.000Z");
    const result = await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:15:00.000Z"));
    expect(result.escalated).toBe(true);
    const alert = (await listOpenAlerts())[0]!;
    expect(alert.alert_type).toBe("scheduled_job_persistent_failure:billing_reconcile");
    expect(JSON.parse(alert.metadata!).capabilityFamily).toBe("scheduled_processing");
  });

  it("does not escalate again while the persistent failure alert is still open (dedup)", async () => {
    for (let i = 0; i < 3; i++) seedSnapshot("billing_reconcile", "failed", `2026-08-10T00:0${i}:00.000Z`);
    await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:15:00.000Z"));
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:20:00.000Z");
    const result = await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:25:00.000Z"));
    expect(result.escalated).toBe(false);
    expect(await listOpenAlerts()).toHaveLength(1);
  });

  it("closure criterion 'recovery closes the alert': resolves the escalation once the job completes again", async () => {
    for (let i = 0; i < 3; i++) seedSnapshot("billing_reconcile", "failed", `2026-08-10T00:0${i}:00.000Z`);
    await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:15:00.000Z"));
    seedSnapshot("billing_reconcile", "completed", "2026-08-10T00:20:00.000Z");
    const result = await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:25:00.000Z"));
    expect(result.resolved).toBe(true);
    expect(await listOpenAlerts()).toHaveLength(0);
  });

  it("a job with no snapshot history yet neither escalates nor resolves", async () => {
    const result = await escalatePersistentJobFailures("billing_renewal_reminder", new Date("2026-08-10T00:00:00.000Z"));
    expect(result).toEqual({ escalated: false, resolved: false });
  });

  it("a mix of failed and completed runs within the last 3 does not escalate", async () => {
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:00:00.000Z");
    seedSnapshot("billing_reconcile", "completed", "2026-08-10T00:05:00.000Z");
    seedSnapshot("billing_reconcile", "failed", "2026-08-10T00:10:00.000Z");
    const result = await escalatePersistentJobFailures("billing_reconcile", new Date("2026-08-10T00:15:00.000Z"));
    expect(result.escalated).toBe(false);
  });
});
