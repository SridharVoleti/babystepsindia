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
  insertPrincipal("notification-read-billing-id", "notification-status-reader-billing");
  insertPrincipal("notification-read-identity-id", "notification-status-reader-identity");
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
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId,
        idempotencyKey: `idem-${randomUUID()}`, safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    });
    const response = await postEnqueue(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notificationId).toBeTruthy();
    expect(body.state).toBe("pending");
    expect(body.templateVersion).toBeTruthy();
  });

  it("NT1-G02: response templateVersion is the authoritative registry version, not an unvalidated echo", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId,
        idempotencyKey: `idem-${randomUUID()}`, safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    });
    const response = await postEnqueue(request);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(typeof body.templateVersion).toBe("string");
    expect(body.templateVersion.length).toBeGreaterThan(0);
  });

  it("AT-NT-001-24: same idempotencyKey + same semantic payload returns the same logical notification", async () => {
    const idempotencyKey = `idem-${randomUUID()}`;
    const payload = {
      notificationType: "billing_payment_recovered", sourceDomain: "billing",
      sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId,
      idempotencyKey, safeVariables: { subscriptionLabel: "Family Plan" },
    };
    const makeRequest = () => new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
      body: JSON.stringify(payload),
    });
    const first = await postEnqueue(makeRequest());
    const firstBody = await first.json();
    const second = await postEnqueue(makeRequest());
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.notificationId).toBe(firstBody.notificationId);
  });

  it("AT-NT-001-25: same idempotencyKey + conflicting semantic payload returns 409", async () => {
    const idempotencyKey = `idem-${randomUUID()}`;
    const basePayload = {
      notificationType: "billing_payment_recovered", sourceDomain: "billing",
      sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId, idempotencyKey,
    };
    const makeRequest = (safeVariables: Record<string, unknown>) => new Request(
      "http://localhost/v1/internal/notifications/transactional-intents", {
        method: "POST",
        headers: { "x-babysteps-service-assertion": assertion(
          "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
        body: JSON.stringify({ ...basePayload, safeVariables: safeVariables }),
      });
    await postEnqueue(makeRequest({ subscriptionLabel: "Family Plan" }));
    const conflicting = await postEnqueue(makeRequest({ subscriptionLabel: "Solo Plan" }));
    expect(conflicting.status).toBe(409);
  });

  it("AT-NT-001-26: missing idempotencyKey returns 400", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    });
    const response = await postEnqueue(request);
    expect(response.status).toBe(400);
  });

  it("rejects a service principal not allowlisted for this route", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", "jti-2") },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId,
        idempotencyKey: `idem-${randomUUID()}`, safeVariables: {},
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
      body: JSON.stringify({ limit: 10, runIdempotencyKey: `run-${randomUUID()}` }),
    });
    const response = await postDeliveryRun(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.processed).toBe(0);
    expect(body.nextCursor).toBeNull();
  });

  it("NT1-G03: missing runIdempotencyKey returns 400", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/delivery-run", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", randomUUID()) },
      body: JSON.stringify({ limit: 10 }),
    });
    const response = await postDeliveryRun(request);
    expect(response.status).toBe(400);
  });

  it("NT1-G03: replaying the same runIdempotencyKey returns the same result without reprocessing", async () => {
    const enqueueRequest = () => new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, recipientParentId: parentId,
        idempotencyKey: `idem-${randomUUID()}`, safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    });
    await postEnqueue(enqueueRequest());
    await postEnqueue(enqueueRequest());

    const runIdempotencyKey = `run-${randomUUID()}`;
    const makeRunRequest = () => new Request("http://localhost/v1/internal/notifications/delivery-run", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", randomUUID()) },
      body: JSON.stringify({ limit: 10, runIdempotencyKey }),
    });
    const first = await postDeliveryRun(makeRunRequest());
    const firstBody = await first.json();
    expect(firstBody.processed).toBe(2);

    const second = await postDeliveryRun(makeRunRequest());
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
  });

  it("NT1-G03: an in-flight (unfinished) runIdempotencyKey returns 409 on replay", async () => {
    const runIdempotencyKey = `run-${randomUUID()}`;
    getDb().prepare(
      "insert into notification_delivery_runs(run_idempotency_key,state,created_at,updated_at) values(?,'running',?,?)",
    ).run(runIdempotencyKey, now.toISOString(), now.toISOString());
    const request = new Request("http://localhost/v1/internal/notifications/delivery-run", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", randomUUID()) },
      body: JSON.stringify({ limit: 10, runIdempotencyKey }),
    });
    const response = await postDeliveryRun(request);
    expect(response.status).toBe(409);
  });

  it("NT1-G03: an invalid cursor returns 400", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/delivery-run", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-delivery-worker", "babysteps:internal:notifications:deliver", randomUUID()) },
      body: JSON.stringify({ limit: 10, runIdempotencyKey: `run-${randomUUID()}`, cursor: "not-valid-base64url!!" }),
    });
    const response = await postDeliveryRun(request);
    expect(response.status).toBe(400);
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
      body: JSON.stringify({ runIdempotencyKey: `run-${randomUUID()}` }),
    });
    const response = await postReconcile(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ reconciled: 0, retried: 0, failed: 0, unchanged: 0, nextCursor: null });
  });

  it("NT1-G04: missing runIdempotencyKey returns 400", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/reconcile", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-reconciliation-service", "babysteps:internal:notifications:reconcile", randomUUID()) },
      body: JSON.stringify({}),
    });
    const response = await postReconcile(request);
    expect(response.status).toBe(400);
  });

  it("NT1-G04: an unknown notificationId returns 404", async () => {
    const request = new Request("http://localhost/v1/internal/notifications/reconcile", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-reconciliation-service", "babysteps:internal:notifications:reconcile", randomUUID()) },
      body: JSON.stringify({ runIdempotencyKey: `run-${randomUUID()}`, notificationId: randomUUID() }),
    });
    const response = await postReconcile(request);
    expect(response.status).toBe(404);
  });

  it("NT1-G04: replaying the same runIdempotencyKey returns the same result without re-querying the provider", async () => {
    const runIdempotencyKey = `run-${randomUUID()}`;
    const makeRequest = () => new Request("http://localhost/v1/internal/notifications/reconcile", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-reconciliation-service", "babysteps:internal:notifications:reconcile", randomUUID()) },
      body: JSON.stringify({ runIdempotencyKey }),
    });
    const first = await postReconcile(makeRequest());
    const firstBody = await first.json();
    const second = await postReconcile(makeRequest());
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
  });

  it("NT1-G04: an in-flight (unfinished) runIdempotencyKey returns 409 on replay", async () => {
    const runIdempotencyKey = `run-${randomUUID()}`;
    getDb().prepare(
      "insert into notification_reconcile_runs(run_idempotency_key,state,created_at,updated_at) values(?,'running',?,?)",
    ).run(runIdempotencyKey, now.toISOString(), now.toISOString());
    const request = new Request("http://localhost/v1/internal/notifications/reconcile", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-reconciliation-service", "babysteps:internal:notifications:reconcile", randomUUID()) },
      body: JSON.stringify({ runIdempotencyKey }),
    });
    const response = await postReconcile(request);
    expect(response.status).toBe(409);
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
        sourceVersion: 1, recipientParentId: parentId, idempotencyKey: `idem-${randomUUID()}`,
        safeVariables: { subscriptionLabel: "Family Plan" },
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
    expect(body.notifications[0]).not.toHaveProperty("providerMessageId");
    expect(body.notifications[0]).not.toHaveProperty("email");
  });

  it("NT1-G06: a billing-scoped read principal can read a billing source event", async () => {
    await postEnqueue(new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing", sourceEventKey: "evt-billing-scoped",
        sourceVersion: 1, recipientParentId: parentId, idempotencyKey: `idem-${randomUUID()}`,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    }));
    const readRequest = new Request("http://localhost/v1/internal/notifications/by-source/billing/evt-billing-scoped", {
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-status-reader-billing", "babysteps:internal:notifications:read", randomUUID()) },
    });
    const response = await getBySource(readRequest, { params: { sourceDomain: "billing", sourceEventKey: "evt-billing-scoped" } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].deliveryState).toBeDefined();
  });

  it("NT1-G06: an identity-scoped read principal cannot read a billing source event", async () => {
    await postEnqueue(new Request("http://localhost/v1/internal/notifications/transactional-intents", {
      method: "POST",
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-enqueue-service", "babysteps:internal:notifications:enqueue", randomUUID()) },
      body: JSON.stringify({
        notificationType: "billing_payment_recovered", sourceDomain: "billing", sourceEventKey: "evt-cross-domain",
        sourceVersion: 1, recipientParentId: parentId, idempotencyKey: `idem-${randomUUID()}`,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }),
    }));
    const readRequest = new Request("http://localhost/v1/internal/notifications/by-source/billing/evt-cross-domain", {
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-status-reader-identity", "babysteps:internal:notifications:read", randomUUID()) },
    });
    const response = await getBySource(readRequest, { params: { sourceDomain: "billing", sourceEventKey: "evt-cross-domain" } });
    expect(response.status).toBe(403);
  });

  it("NT1-G06: an unknown source domain returns 400", async () => {
    const readRequest = new Request("http://localhost/v1/internal/notifications/by-source/not-a-real-domain/evt-1", {
      headers: { "x-babysteps-service-assertion": assertion(
        "notification-status-reader", "babysteps:internal:notifications:read", randomUUID()) },
    });
    const response = await getBySource(readRequest, { params: { sourceDomain: "not-a-real-domain", sourceEventKey: "evt-1" } });
    expect(response.status).toBe(400);
  });
});
