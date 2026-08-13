// @vitest-environment node
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { GET as getBySource } from "@/app/v1/internal/notifications/by-source/[sourceDomain]/[sourceEventKey]/route";
import { POST as postDeliveryRun } from "@/app/v1/internal/notifications/delivery-run/route";
import { POST as postReconcile } from "@/app/v1/internal/notifications/reconcile/route";
import { POST as postEnqueue } from "@/app/v1/internal/notifications/transactional-intents/route";

const now = new Date();
const serviceKeys = generateKeyPairSync("ed25519");
const servicePrivateKeyPem = serviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let parentId: string;

function insertPrincipal(id: string, serviceKey: string) {
  getDb().prepare(
    `insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
     values(?,?,'ref',?,'active',?,?,1)`,
  ).run(id, serviceKey, serviceKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
}

function assertion(serviceKey: string, audience: string, jti: string) {
  return createPlatformServiceAssertion({ serviceKey, audience, jti, now, privateKeyPem: servicePrivateKeyPem });
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-routes-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  insertPrincipal("notification-enqueue-id", "notification-enqueue-service");
  insertPrincipal("notification-delivery-id", "notification-delivery-worker");
  insertPrincipal("notification-reconcile-id", "notification-reconciliation-service");
  insertPrincipal("notification-read-id", "notification-status-reader");
});

describe("NT-001 API-NT-001 POST /v1/internal/notifications/transactional-intents", () => {
  it("AT-NT-001-02: rejects a request without a valid service assertion", async () => {
    const response = await postEnqueue(new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(response.status).toBe(401);
  });

  it("enqueues a valid transactional intent for an authenticated source-service principal", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", "jti-1") },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    });
    const response = await postEnqueue(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notificationId).toBeTruthy();
    expect(body.state).toBe("pending");
  });

  it("rejects a service principal not allowlisted for this route", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", "jti-2") },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId, safeVariables: {},
      }),
    });
    const response = await postEnqueue(request);
    expect(response.status).toBe(401);
  });
});

describe("NT-001 API-NT-002 POST /v1/internal/notifications/delivery-run", () => {
  it("rejects without a valid service assertion", async () => {
    const response = await postDeliveryRun(new Request("http://localhost/v1/internal/notifications/delivery-run", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(response.status).toBe(401);
  });

  it("runs the delivery sweep for an authenticated worker principal", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/delivery-run", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", "jti-3") },
      body: JSON.stringify({ limit: 10 }),
    });
    const response = await postDeliveryRun(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.claimed).toBe(0);
  });
});

describe("NT-001 API-NT-004 POST /v1/internal/notifications/reconcile", () => {
  it("rejects without a valid service assertion", async () => {
    const response = await postReconcile(new Request("http://localhost/v1/internal/notifications/reconcile", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(response.status).toBe(401);
  });

  it("runs reconciliation for an authenticated reconciliation principal", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/reconcile", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-reconciliation-service", "babysteps:internal:notifications:reconcile", "jti-4") },
      body: JSON.stringify({}),
    });
    const response = await postReconcile(request);
    expect(response.status).toBe(200);
  });
});

describe("NT-001 API-NT-005 GET /v1/internal/notifications/by-source/{sourceDomain}/{sourceEventKey}", () => {
  it("rejects without a valid service assertion", async () => {
    const response = await getBySource(
      new Request("http://localhost/v1/internal/notifications/by-source/billing/evt-1"),
      { params: { sourceDomain: "billing", sourceEventKey: "evt-1" } },
    );
    expect(response.status).toBe(401);
  });

  it("returns compact delivery status by source identity for an authenticated read principal", async () => {
    const enqueueRequest = new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", "jti-5") },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing", sourceEventKey: "evt-lookup-1",
        sourceVersion: 1, parentId, safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    });
    await postEnqueue(enqueueRequest);

    const readRequest = new Request("http://localhost/v1/internal/notifications/by-source/billing/evt-lookup-1", {
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-status-reader", "babysteps:internal:notifications:read", "jti-6") },
    });
    const response = await getBySource(readRequest, { params: { sourceDomain: "billing", sourceEventKey: "evt-lookup-1" } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].notificationType).toBe("billing_payment_recovered");
  });
});
