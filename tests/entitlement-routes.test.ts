import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { POST as applyPaidCycleRoute } from "@/app/v1/internal/entitlements/apply-paid-cycle/route";
import { POST as evaluateAccessRoute } from "@/app/v1/internal/entitlements/evaluate-access/route";

// The service-assertion JWT is checked against real wall-clock time inside
// requireInternalService (routes don't accept an injected `now`), so this
// must be actual current time — unrelated to the fixed 2026 dates used for
// entitlement period data in the request bodies below.
const now = new Date();
const applierKeys = generateKeyPairSync("ed25519");
const evaluatorKeys = generateKeyPairSync("ed25519");
const applierPrivateKeyPem = applierKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const evaluatorPrivateKeyPem = evaluatorKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const appId = "math-app";
let parentId: string;
let learnerId: string;

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "Math App");
  const { user } = await sqliteAuthAdapter.signUp("route-parent@example.com", "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: "20000000-0000-4000-8000-000000000001" }, "2026-08-01")).learner.id;
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
    values('applier-id','entitlement-cycle-applier','applier-ref',?,'active','2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',1),
          ('evaluator-id','entitlement-access-evaluator','evaluator-ref',?,'active','2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',1)`)
    .run(applierKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
});

function applyRequest(body: unknown, jti = "apply-1") {
  const assertion = createPlatformServiceAssertion({ serviceKey: "entitlement-cycle-applier",
    audience: "babysteps:internal:entitlements:apply_cycle", jti, now, privateKeyPem: applierPrivateKeyPem });
  return new Request("http://localhost/v1/internal/entitlements/apply-paid-cycle", {
    method: "POST", headers: { "x-babysteps-service-assertion": assertion, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function evaluateRequest(body: unknown, jti = "evaluate-1") {
  const assertion = createPlatformServiceAssertion({ serviceKey: "entitlement-access-evaluator",
    audience: "babysteps:internal:entitlements:evaluate_access", jti, now, privateKeyPem: evaluatorPrivateKeyPem });
  return new Request("http://localhost/v1/internal/entitlements/evaluate-access", {
    method: "POST", headers: { "x-babysteps-service-assertion": assertion, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validApplyBody(overrides: Record<string, unknown> = {}) {
  // The route computes `now` internally via `new Date()` (routes accept no
  // injected clock), so the period must bracket real wall-clock time for an
  // "allowed" assertion to be meaningful — not a fixed date that may already
  // be in the past or future relative to the actual sandbox clock.
  const periodStart = new Date(now.getTime() - 86_400_000).toISOString();
  const periodEnd = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  return {
    paidCycleId: "cycle-1", eventId: "event-1", eventVersion: 1,
    subscriptionId: "sub-1", purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: "product-1", productVersion: 1, appIds: [appId],
    periodStart, periodEnd,
    billingAnchor: periodStart.slice(0, 10), environment: "production", ...overrides,
  };
}

describe("EN-001 POST /v1/internal/entitlements/apply-paid-cycle", () => {
  it("rejects a request with no service assertion", async () => {
    const response = await applyPaidCycleRoute(new Request("http://localhost/v1/internal/entitlements/apply-paid-cycle", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("applies a well-formed paid-cycle event and returns the ready cycle", async () => {
    const response = await applyPaidCycleRoute(await applyRequest(validApplyBody()));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe("ready");
    expect(json.appPeriods).toHaveLength(1);
  });

  it("rejects a malformed body before touching the domain service", async () => {
    const response = await applyPaidCycleRoute(await applyRequest({ paidCycleId: "only-one-field" }));
    expect(response.status).toBe(400);
  });

  it("maps a domain error to its HTTP status", async () => {
    const response = await applyPaidCycleRoute(await applyRequest(validApplyBody({ appIds: ["nonexistent-app"] })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("ENTITLEMENT_APP_CONFIGURATION_INVALID");
  });
});

describe("EN-002 POST /v1/internal/entitlements/evaluate-access", () => {
  it("rejects a request with no service assertion", async () => {
    const response = await evaluateAccessRoute(new Request("http://localhost/v1/internal/entitlements/evaluate-access", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("returns a denied decision for a learner/app with no entitlement", async () => {
    const response = await evaluateAccessRoute(await evaluateRequest({ learnerId, appId, environment: "production", useCase: "start" }));
    expect(response.status).toBe(200);
    expect((await response.json()).allowed).toBe(false);
  });

  it("returns an allowed decision once EN-001 has applied a covering paid cycle", async () => {
    await applyPaidCycleRoute(await applyRequest(validApplyBody()));
    const response = await evaluateAccessRoute(await evaluateRequest({ learnerId, appId, environment: "production", useCase: "start" }, "evaluate-2"));
    expect((await response.json()).allowed).toBe(true);
  });

  it("rejects an unknown useCase", async () => {
    const response = await evaluateAccessRoute(await evaluateRequest({ learnerId, appId, environment: "production", useCase: "bogus" }));
    expect(response.status).toBe(400);
  });
});
