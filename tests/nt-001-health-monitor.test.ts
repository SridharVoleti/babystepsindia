// @vitest-environment node
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { monitorNotificationDeliveryHealth } from "@/lib/notifications/health-monitor";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";
import { POST as postHealthMonitor } from "@/app/v1/internal/notifications/health/monitor/route";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-health-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

function enqueueAt(sourceEventKey: string, createdAt: string) {
  return enqueueTransactionalNotification({
    notificationType: "billing_payment_recovered", sourceDomain: "billing",
    sourceEventKey, sourceVersion: 1, parentId, safeVariables: { subscriptionLabel: "Family Plan" },
  }, new Date(createdAt)).notificationId;
}

function openAlerts(alertType: string) {
  return getDb().prepare("select count(*) n from platform_alerts where alert_type=? and resolved_at is null")
    .get(alertType) as { n: number };
}

describe("NT-001 (NT1-G08) monitorNotificationDeliveryHealth", () => {
  it("creates no alerts when the queue is healthy", () => {
    const outcome = monitorNotificationDeliveryHealth(new Date("2026-08-13T00:00:00.000Z"));
    expect(outcome.alertsCreated).toEqual([]);
  });

  it("creates a queue-age alert once the threshold is breached, and never a second one while still open", () => {
    enqueueAt(`evt-${randomUUID()}`, "2026-08-13T00:00:00.000Z");
    const first = monitorNotificationDeliveryHealth(new Date("2026-08-13T01:00:00.000Z"));
    expect(first.alertsCreated).toEqual(["notification_queue_age_breach"]);
    expect(openAlerts("notification_queue_age_breach").n).toBe(1);

    const second = monitorNotificationDeliveryHealth(new Date("2026-08-13T01:05:00.000Z"));
    expect(second.alertsCreated).toEqual([]);
    expect(openAlerts("notification_queue_age_breach").n).toBe(1);
  });

  it("creates a fresh alert after the prior one is resolved (platform monitoring policy: dedup only while open)", () => {
    enqueueAt(`evt-${randomUUID()}`, "2026-08-13T00:00:00.000Z");
    monitorNotificationDeliveryHealth(new Date("2026-08-13T01:00:00.000Z"));
    getDb().prepare("update platform_alerts set resolved_at=? where alert_type='notification_queue_age_breach'")
      .run("2026-08-13T01:10:00.000Z");
    const after = monitorNotificationDeliveryHealth(new Date("2026-08-13T02:00:00.000Z"));
    expect(after.alertsCreated).toEqual(["notification_queue_age_breach"]);
  });

  it("creates a provider-health-degraded alert on a burst of recent temporary provider failures", () => {
    for (let i = 0; i < 5; i++) enqueueAt(`evt-degraded-${i}`, "2026-08-13T00:00:00.000Z");
    const now = new Date("2026-08-13T00:00:00.000Z");
    runNotificationDeliverySweep({ provider: { send: () => ({ status: "failed" as const }) }, now, limit: 20 });
    const outcome = monitorNotificationDeliveryHealth(new Date(now.getTime() + 60_000));
    expect(outcome.alertsCreated).toContain("notification_provider_health_degraded");
  });
});

describe("NT-001 (NT1-G08) POST /v1/internal/notifications/health/monitor", () => {
  const serviceKeys = generateKeyPairSync("ed25519");
  const servicePrivateKeyPem = serviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = new Date();

  beforeEach(() => {
    getDb().prepare(
      `insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
       values(?,?,'ref',?,'active',?,?,1)`,
    ).run("notification-health-monitor-id", "notification-health-monitor",
      serviceKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  });

  it("rejects without a valid service assertion", async () => {
    const response = await postHealthMonitor(new Request("http://localhost/v1/internal/notifications/health/monitor", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(response.status).toBe(401);
  });

  it("runs the health/alert sweep for an authenticated monitor principal", async () => {
    const assertion = createPlatformServiceAssertion({
      serviceKey: "notification-health-monitor", audience: "babysteps:internal:notifications:monitor_health",
      jti: randomUUID(), now, privateKeyPem: servicePrivateKeyPem,
    });
    const response = await postHealthMonitor(new Request("http://localhost/v1/internal/notifications/health/monitor", {
      method: "POST", headers: { "x-babysteps-service-assertion": assertion }, body: JSON.stringify({}),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.health).toBeDefined();
    expect(body.alertsCreated).toEqual([]);
  });
});
