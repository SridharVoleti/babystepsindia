import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireInternalService: vi.fn() }));
vi.mock("@/lib/auth/internal-service-guard", () => ({ requireInternalService: mocks.requireInternalService }));

import { POST as reportBackupStatus } from "@/app/v1/internal/backup-status/route";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { listOpenAlerts } from "@/lib/monitoring/alerting";

const serviceGuard = { ok: true, principal: { id: "service-1" } };

function req(body: unknown) {
  return new Request("http://localhost/v1/internal/backup-status", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  useInMemoryDb();
  vi.clearAllMocks();
  mocks.requireInternalService.mockResolvedValue(serviceGuard);
});

describe("POST /v1/internal/backup-status", () => {
  it("requires the backup-status-reporter service identity", async () => {
    await reportBackupStatus(req({ status: "completed", occurredAt: "2026-08-17T02:00:00.000Z" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.anything(), "backup-status-reporter");
  });

  it("denies when the internal service guard rejects", async () => {
    mocks.requireInternalService.mockResolvedValueOnce({ ok: false, response: Response.json({ error: "AUTHORIZATION_DENIED" }, { status: 403 }) });
    const response = await reportBackupStatus(req({ status: "completed", occurredAt: "2026-08-17T02:00:00.000Z" }));
    expect(response.status).toBe(403);
  });

  it("rejects a malformed payload", async () => {
    const response = await reportBackupStatus(req({ status: "unknown", occurredAt: "not-a-date" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_PAYLOAD" });
  });

  it("a 'failed' report raises a deduplicated critical alert in the critical_providers family", async () => {
    const response = await reportBackupStatus(req({ status: "failed", occurredAt: "2026-08-17T02:00:00.000Z", providerRef: "backup-run-42" }));
    expect(response.status).toBe(200);
    const alerts = await listOpenAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe("provider_backup_failure");
    const metadata = JSON.parse(alerts[0].metadata!);
    expect(metadata).toMatchObject({ capabilityFamily: "critical_providers", severity: "critical", providerRef: "backup-run-42" });
  });

  it("a second 'failed' report does not create a duplicate open alert", async () => {
    await reportBackupStatus(req({ status: "failed", occurredAt: "2026-08-17T02:00:00.000Z" }));
    await reportBackupStatus(req({ status: "failed", occurredAt: "2026-08-17T03:00:00.000Z" }));
    expect(await listOpenAlerts()).toHaveLength(1);
  });

  it("a 'completed' report resolves a previously open backup-failure alert", async () => {
    await reportBackupStatus(req({ status: "failed", occurredAt: "2026-08-17T02:00:00.000Z" }));
    expect(await listOpenAlerts()).toHaveLength(1);

    const response = await reportBackupStatus(req({ status: "completed", occurredAt: "2026-08-17T03:00:00.000Z" }));
    expect(response.status).toBe(200);
    expect(await listOpenAlerts()).toHaveLength(0);
  });

  it("a 'completed' report with no open alert is a safe no-op", async () => {
    const response = await reportBackupStatus(req({ status: "completed", occurredAt: "2026-08-17T02:00:00.000Z" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ resolved: false });
  });
});
