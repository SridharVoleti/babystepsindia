import { describe, expect, it } from "vitest";
import {
  classifyApplicationHealth,
  safeUserMessage,
  type ApplicationHealthSignal,
} from "@/lib/application-health/contracts";
import { ApplicationHealthService } from "@/lib/application-health/service";

const requiredCapabilities = [
  "billing",
  "entitlement_access",
  "progress",
  "notification",
  "scheduled_processing",
  "privacy_deletion",
  "app_platform_contract",
  "data_integrity",
  "critical_provider",
] as const;

function signal(overrides: Partial<ApplicationHealthSignal> = {}): ApplicationHealthSignal {
  return {
    capability: "billing",
    issueKey: "provider-renewal-processing",
    impact: "renewals delayed",
    firstObservedAt: "2026-08-17T01:00:00.000Z",
    lastObservedAt: "2026-08-17T01:10:00.000Z",
    consecutiveFailures: 3,
    recoveryAttempts: 2,
    recoveryExhausted: true,
    degraded: true,
    safeDiagnosticCode: "PROVIDER_TIMEOUT",
    correlationId: "corr_01",
    ...overrides,
  };
}

describe("AN-003 application health and major-issue alerting", () => {
  it("AT-AN-003-01 covers every frozen capability family", () => {
    for (const capability of requiredCapabilities) {
      expect(classifyApplicationHealth(signal({ capability }))).toMatchObject({
        capability,
      });
    }
  });

  it("AT-AN-003-02 retries/reconciles/degrades before escalation", () => {
    expect(classifyApplicationHealth(signal({ recoveryExhausted: false }))).toMatchObject({
      shouldAlert: false,
      severity: "recoverable",
    });
    expect(classifyApplicationHealth(signal({ recoveryExhausted: true, consecutiveFailures: 3 }))).toMatchObject({
      shouldAlert: true,
      severity: "major",
    });
  });

  it("AT-AN-003-03 critical conditions escalate immediately once recovery is exhausted", () => {
    expect(classifyApplicationHealth(signal({
      impact: "access decisions unavailable",
      critical: true,
      recoveryExhausted: true,
    }))).toMatchObject({ shouldAlert: true, severity: "critical" });
  });

  it("AT-AN-003-04 deduplicates persistent failures and closes on recovery", async () => {
    const writes: Array<{ action: string; key: string }> = [];
    const repo = {
      async upsertOpenAlert(input: { dedupeKey: string }) {
        writes.push({ action: "upsert", key: input.dedupeKey });
        return { id: "alert-1", created: writes.length === 1 };
      },
      async closeOpenAlert(dedupeKey: string) {
        writes.push({ action: "close", key: dedupeKey });
      },
    };
    const service = new ApplicationHealthService(repo);
    await service.observe(signal());
    await service.observe(signal({ lastObservedAt: "2026-08-17T01:11:00.000Z", consecutiveFailures: 4 }));
    await service.recover("billing", "provider-renewal-processing", "2026-08-17T01:12:00.000Z");
    expect(writes.filter((w) => w.action === "upsert")).toHaveLength(2);
    expect(new Set(writes.filter((w) => w.action === "upsert").map((w) => w.key)).size).toBe(1);
    expect(writes.at(-1)?.action).toBe("close");
  });

  it("AT-AN-003-05 alerts contain only privacy-safe diagnostics", () => {
    const classified = classifyApplicationHealth(signal());
    expect(classified).toEqual(expect.objectContaining({
      capability: "billing",
      impact: "renewals delayed",
      recoveryState: "exhausted",
      safeDiagnosticCode: "PROVIDER_TIMEOUT",
      correlationId: "corr_01",
    }));
    expect(JSON.stringify(classified)).not.toMatch(/email|phone|learner[_-]?id|token|secret|payload/i);
  });

  it("AT-AN-003-06 user-facing errors stay simple and non-technical", () => {
    expect(safeUserMessage("PROVIDER_TIMEOUT")).toBe("This service is temporarily unavailable. Please try again shortly.");
    expect(safeUserMessage("DB_CONSTRAINT_INTERNAL")).not.toMatch(/constraint|database|stack|sql/i);
  });

  it("AT-AN-003-07 alerting is observational and cannot mutate owning-domain state", async () => {
    const repo = {
      async upsertOpenAlert() { return { id: "a", created: true }; },
      async closeOpenAlert() {},
    };
    const service = new ApplicationHealthService(repo);
    expect(Object.keys(service).sort()).toEqual(["repo"]);
    await expect(service.observe(signal())).resolves.toEqual(expect.objectContaining({ alertId: "a" }));
  });
});
