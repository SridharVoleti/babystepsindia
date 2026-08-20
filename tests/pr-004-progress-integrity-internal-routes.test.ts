import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeProtectedAppApi: vi.fn(async () => ({
    grantId: "grant-1", learnerSessionId: "session-1", learnerId: "learner-1", appId: "app-1",
    principalId: "principal-1", scopes: [], principal: {},
  })),
}));

vi.mock("@/lib/app-authorization/guard", () => ({ authorizeProtectedAppApi: mocks.authorizeProtectedAppApi }));

import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";
import { computeCanonicalStateHash } from "@/lib/progress-integrity/service";
import { POST as postValidateIntegrity } from "@/app/v1/internal/learner-app-progress/validate-integrity/route";
import { POST as postReconcileIntegrity } from "@/app/v1/internal/learner-app-progress/reconcile-integrity/route";

async function createLearnerFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr004introute-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  return (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner;
}

// The routes under test authenticate service assertions against the real
// system clock (they don't accept an injected `now`), so this fixture
// clock must be real time too, not a fixed fictional date — the assertion
// has only a 60-second validity window (see createPlatformServiceAssertion).
const now = new Date();
const appId = "app-1";
const environment = "production";
const serviceKeys = generateKeyPairSync("ed25519");
const servicePrivateKeyPem = serviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeProtectedAppApi.mockResolvedValue({
    grantId: "grant-1", learnerSessionId: "session-1", learnerId: "learner-1", appId: "app-1",
    principalId: "principal-1", scopes: [], principal: {},
  });
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
    values('progress-integrity-id','progress-integrity-reconciler','ref',?,'active',?,?,1)`)
    .run(serviceKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
});

function serviceAssertion(jti: string) {
  return createPlatformServiceAssertion({ serviceKey: "progress-integrity-reconciler",
    audience: "babysteps:internal:progress:reconcile", jti, now, privateKeyPem: servicePrivateKeyPem });
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("PR-004 POST /v1/internal/learner-app-progress/validate-integrity", () => {
  it("authorizes via the app grant token for reason=read and derives learner/app from it", async () => {
    const learner = await createLearnerFixture();
    mocks.authorizeProtectedAppApi.mockResolvedValueOnce({
      grantId: "grant-1", learnerSessionId: "session-1", learnerId: learner.id, appId,
      principalId: "principal-1", scopes: [], principal: {},
    });
    const response = await postValidateIntegrity(jsonRequest("http://localhost", { reason: "read" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.classification).toBe("healthy");
    expect(mocks.authorizeProtectedAppApi).toHaveBeenCalledWith(expect.anything(), "progress.integrity_validate");
  });

  it("rejects reason=reconcile without a valid service assertion", async () => {
    const learner = await createLearnerFixture();
    const response = await postValidateIntegrity(jsonRequest("http://localhost", { reason: "reconcile",
      learnerId: learner.id, appId, environment }));
    expect(response.status).toBe(401);
  });

  it("authorizes reason=reconcile via the progress-integrity service principal against an explicit target", async () => {
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 1,
      schemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }), now });
    const learner = await createLearnerFixture();
    const state = JSON.stringify({ level: "l1" });
    const hash = computeCanonicalStateHash({ learnerId: learner.id, appId, environment, progressVersion: 1,
      schemaVersion: 1, serializedState: state });
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,state_hash,updated_at)
      values(?,?,1,?,1,?,?)`).run(learner.id, appId, state, hash, now.toISOString());

    const response = await postValidateIntegrity(jsonRequest("http://localhost",
      { reason: "reconcile", learnerId: learner.id, appId, environment },
      { "x-babysteps-service-assertion": serviceAssertion("via-jti-1") }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.classification).toBe("healthy");
  });

  it("rejects an unrecognized reason", async () => {
    const response = await postValidateIntegrity(jsonRequest("http://localhost", { reason: "bogus" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_REQUEST" });
  });

  it("rejects malformed JSON", async () => {
    const response = await postValidateIntegrity(new Request("http://localhost", { method: "POST", body: "{not json" }));
    expect(response.status).toBe(400);
  });
});

describe("PR-004 POST /v1/internal/learner-app-progress/reconcile-integrity", () => {
  it("rejects without a valid service assertion", async () => {
    const response = await postReconcileIntegrity(jsonRequest("http://localhost", { environment, runIdempotencyKey: "run-1" }));
    expect(response.status).toBe(401);
  });

  it("runs the sweep for an authenticated progress-integrity principal", async () => {
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 1,
      schemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }), now });
    const learner = await createLearnerFixture();
    const state = JSON.stringify({ level: "l1" });
    const hash = computeCanonicalStateHash({ learnerId: learner.id, appId, environment, progressVersion: 1,
      schemaVersion: 1, serializedState: state });
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,state_hash,updated_at)
      values(?,?,1,?,1,?,?)`).run(learner.id, appId, state, hash, now.toISOString());

    const response = await postReconcileIntegrity(jsonRequest("http://localhost",
      { environment, runIdempotencyKey: "run-1", limit: 10 }, { "x-babysteps-service-assertion": serviceAssertion("sweep-jti-1") }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.processed).toBe(1);
  });

  it("rejects a missing environment", async () => {
    const response = await postReconcileIntegrity(jsonRequest("http://localhost", { runIdempotencyKey: "run-2" },
      { "x-babysteps-service-assertion": serviceAssertion("sweep-jti-2") }));
    expect(response.status).toBe(400);
  });
});
