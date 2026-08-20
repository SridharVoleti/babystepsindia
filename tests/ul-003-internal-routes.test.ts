import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { POST as invalidate } from "@/app/v1/internal/learner-launcher/invalidate/route";
import { POST as reconcile } from "@/app/v1/internal/learner-launcher/reconcile-freshness/route";

const now = new Date();
const outboxKeys = generateKeyPairSync("ed25519");
const reconcileKeys = generateKeyPairSync("ed25519");
const privatePem = (keys: typeof outboxKeys) => keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = (keys: typeof outboxKeys) => keys.publicKey.export({ type: "spki", format: "pem" }).toString();
let learnerId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul003-route-${randomUUID()}@example.com`, "CorrectHorse1!");
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-11")).learner.id;
  getDb().prepare(`insert into platform_service_principals
    (id,service_key,key_ref,public_key,status,valid_from,valid_until,version) values
    ('outbox-id','learner-launcher-domain-outbox','test',?,'active',?,'2099-01-01T00:00:00.000Z',1),
    ('reconcile-id','learner-launcher-reconciliation','test',?,'active',?,'2099-01-01T00:00:00.000Z',1)`)
    .run(publicPem(outboxKeys), new Date(now.getTime() - 60_000).toISOString(), publicPem(reconcileKeys),
      new Date(now.getTime() - 60_000).toISOString());
});

function request(path: string, serviceKey: string, audience: string, jti: string,
  key: typeof outboxKeys, body: Record<string, unknown>) {
  const assertion = createPlatformServiceAssertion({ serviceKey, audience, jti, now, privateKeyPem: privatePem(key) });
  return new Request(`http://x${path}`, { method: "POST", headers: {
    "content-type": "application/json", "x-babysteps-service-assertion": assertion,
  }, body: JSON.stringify(body) });
}

describe("UL-003 internal freshness APIs", () => {
  it("API-UL-009 accepts only the exact domain-outbox principal and returns safe metadata", async () => {
    const response = await invalidate(request("/v1/internal/learner-launcher/invalidate",
      "learner-launcher-domain-outbox", "babysteps:internal:launcher:invalidate", "invalidate-1", outboxKeys,
      { learnerId, sourceType: "session", sourceVersion: 3, eventId: "domain-event-1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ accepted: true, learnerId, sourceType: "session",
      sourceVersion: "3", eventId: "domain-event-1", invalidationVersion: 1 });
  });

  it("API-UL-010 performs bounded derived-only reconciliation under its distinct principal", async () => {
    const response = await reconcile(request("/v1/internal/learner-launcher/reconcile-freshness",
      "learner-launcher-reconciliation", "babysteps:internal:launcher:reconcile_freshness", "reconcile-1",
      reconcileKeys, { learnerId, limit: 10, runIdempotencyKey: "run-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repaired: 1, errors: 0, nextCursor: null });
  });

  it("does not accept a reconciliation assertion at the invalidation boundary", async () => {
    const response = await invalidate(request("/v1/internal/learner-launcher/invalidate",
      "learner-launcher-reconciliation", "babysteps:internal:launcher:reconcile_freshness", "cross-role-1",
      reconcileKeys, { learnerId, sourceType: "session", sourceVersion: 1, eventId: "event-cross" }));
    expect([401, 403]).toContain(response.status);
  });
});
