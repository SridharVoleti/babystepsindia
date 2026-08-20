import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeProtectedAppApi: vi.fn(async () => ({
    grantId: "grant-1", learnerSessionId: "session-1", learnerId: "learner-1", appId: "app-1",
    principalId: "principal-1", scopes: [], principal: {},
  })),
  requireAdminApi: vi.fn<() => Promise<{ ok: true; session: { sub: string; email: string }; principal: object } |
    { ok: false; response: unknown }>>(async () => ({
    ok: true, session: { sub: "admin-1", email: "admin@example.com" }, principal: {},
  })),
}));

vi.mock("@/lib/app-authorization/guard", () => ({ authorizeProtectedAppApi: mocks.authorizeProtectedAppApi }));
vi.mock("@/lib/auth/admin-api-guard", () => ({ requireAdminApi: mocks.requireAdminApi }));

import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { saveCheckpoint } from "@/lib/app-progress/service";
import { POST as postRecoverCurrent } from "@/app/v1/internal/learner-app-progress/recover-current/route";
import { POST as postReconcileRecovery } from "@/app/v1/internal/learner-app-progress/reconcile-recovery/route";
import { GET as getRecoveryIncidents } from "@/app/v1/admin/apps/[appId]/progress-recovery-incidents/route";

const now = new Date();
const appId = "app-1";
const releaseId = "release-1";
const deploymentId = "deployment-1";
const environment = "production";
const deviceSessionId = "device-1";
const credential = "resume-credential-1";
const resumeTokenHash = createHash("sha256").update(credential).digest("hex");
const principalId = "principal-1";
const serviceKeys = generateKeyPairSync("ed25519");
const servicePrivateKeyPem = serviceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeProtectedAppApi.mockResolvedValue({
    grantId: "grant-1", learnerSessionId: "session-1", learnerId: "learner-1", appId: "app-1",
    principalId: "principal-1", scopes: [], principal: {},
  });
  mocks.requireAdminApi.mockResolvedValue({ ok: true, session: { sub: "admin-1", email: "admin@example.com" }, principal: {} });
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  const schema = JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
  getDb().prepare(`insert into app_progress_schemas(app_id,release_id,schema_version,schema_json,schema_digest,status,created_at)
    values(?,?,1,?,?,'active',?)`).run(appId, releaseId, schema, createHash("sha256").update(schema).digest("hex"), now.toISOString());
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
    values('progress-recovery-id','progress-recovery-reconciler','ref',?,'active',?,?,1)`)
    .run(serviceKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
});

async function createLearnerFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr002routes-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner;
  return { user, learner };
}

function insertActiveSession(sessionId: string, learnerId: string, parentUserId: string) {
  const columns = {
    id: sessionId, learner_id: learnerId, app_id: appId, parent_user_id: parentUserId,
    parent_session_id: "parent-session-1", device_session_id: deviceSessionId,
    week_key: "2026-W32", week_timezone: "Asia/Kolkata", weekly_slot_number: 1, source: "normal",
    status: "active", schedule_authorization_id: "schedule-1", started_at: now.toISOString(),
    resume_token_hash: resumeTokenHash, deployment_id: deploymentId, release_id: releaseId,
    deployment_environment: environment, hard_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  const keys = Object.keys(columns);
  getDb().prepare(`insert into learner_sessions(${keys.join(",")}) values(${keys.map(() => "?").join(",")})`)
    .run(...keys.map((key) => columns[key as keyof typeof columns]));
}

function seedInitialProgress(sessionId: string, learnerId: string) {
  getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
    values(?,?,?,?,?,?,'active',?,?,1)`).run(principalId, appId, environment, deploymentId, "client-1", "test-key",
    "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  getDb().prepare(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values('grant-1',?,?,?,?,?,?,?,'["progress.read","progress.write","progress.recover"]','1.0',1,'active',?,?,?)`)
    .run(sessionId, learnerId, appId, environment, deploymentId, releaseId, principalId,
      new Date(now.getTime() + 3_600_000).toISOString(), now.toISOString(), now.toISOString());
  return saveCheckpoint({ grantId: "grant-1", principalId, learnerSessionId: sessionId, learnerId, appId }, {
    expectedProgressVersion: 0, checkpointSequence: 1, stateSchemaVersion: 1,
    currentLevelKey: "level-1", currentLessonKey: "lesson-1", currentState: { level: "l1" },
    checkpointIdempotencyKey: "checkpoint-1",
  }, now);
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function serviceAssertion(jti: string) {
  return createPlatformServiceAssertion({ serviceKey: "progress-recovery-reconciler",
    audience: "babysteps:internal:progress:reconcile_recovery", jti, now, privateKeyPem: servicePrivateKeyPem });
}

describe("PR-002 POST /v1/internal/learner-app-progress/recover-current", () => {
  it("recovers pending state end-to-end through the real route", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    seedInitialProgress(sessionId, learner.id);
    mocks.authorizeProtectedAppApi.mockResolvedValue({
      grantId: "grant-1", learnerSessionId: sessionId, learnerId: learner.id, appId, principalId, scopes: [], principal: {},
    });
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;

    const response = await postRecoverCurrent(jsonRequest("http://localhost", {
      deviceSessionId, credential, expectedProgressVersion: 1, baseStateHash: baseHash, recoverySequence: 1,
      stateSchemaVersion: 1, pendingState: { level: "l1-pending" }, recoveryCapsuleId: "capsule-1", idempotencyKey: "recovery-1",
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBe("recovered");
    expect(body.newProgressVersion).toBe(2);
  });

  it("maps PROGRESS_RECOVERY_STALE to 409", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    seedInitialProgress(sessionId, learner.id);
    mocks.authorizeProtectedAppApi.mockResolvedValue({
      grantId: "grant-1", learnerSessionId: sessionId, learnerId: learner.id, appId, principalId, scopes: [], principal: {},
    });
    const response = await postRecoverCurrent(jsonRequest("http://localhost", {
      deviceSessionId, credential, expectedProgressVersion: 1, baseStateHash: "wrong-hash", recoverySequence: 1,
      stateSchemaVersion: 1, pendingState: { level: "x" }, recoveryCapsuleId: "capsule-1", idempotencyKey: "recovery-1",
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "PROGRESS_RECOVERY_STALE" });
  });

  it("rejects a malformed body", async () => {
    const response = await postRecoverCurrent(jsonRequest("http://localhost", { deviceSessionId }));
    expect(response.status).toBe(400);
  });
});

describe("PR-002 POST /v1/internal/learner-app-progress/reconcile-recovery", () => {
  it("rejects without a valid service assertion", async () => {
    const response = await postReconcileRecovery(jsonRequest("http://localhost", { receiptId: "x" }));
    expect(response.status).toBe(401);
  });

  it("confirms a matching receipt for an authenticated progress-recovery principal", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    seedInitialProgress(sessionId, learner.id);
    mocks.authorizeProtectedAppApi.mockResolvedValue({
      grantId: "grant-1", learnerSessionId: sessionId, learnerId: learner.id, appId, principalId, scopes: [], principal: {},
    });
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await postRecoverCurrent(jsonRequest("http://localhost", {
      deviceSessionId, credential, expectedProgressVersion: 1, baseStateHash: baseHash, recoverySequence: 1,
      stateSchemaVersion: 1, pendingState: { level: "l1-pending" }, recoveryCapsuleId: "capsule-1", idempotencyKey: "recovery-1",
    }));
    const receipt = getDb().prepare("select id from progress_recovery_receipts where learner_session_id=?").get(sessionId) as { id: string };

    const response = await postReconcileRecovery(jsonRequest("http://localhost", { receiptId: receipt.id },
      { "x-babysteps-service-assertion": serviceAssertion("reconcile-jti-1") }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.confirmed).toBe(true);
  });
});

describe("PR-002 GET /v1/admin/apps/[appId]/progress-recovery-incidents", () => {
  it("returns a safe incident list for an admin with the exact permission", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    seedInitialProgress(sessionId, learner.id);
    mocks.authorizeProtectedAppApi.mockResolvedValue({
      grantId: "grant-1", learnerSessionId: sessionId, learnerId: learner.id, appId, principalId, scopes: [], principal: {},
    });
    await postRecoverCurrent(jsonRequest("http://localhost", {
      deviceSessionId, credential, expectedProgressVersion: 1, baseStateHash: "wrong-hash", recoverySequence: 1,
      stateSchemaVersion: 1, pendingState: { level: "x" }, recoveryCapsuleId: "capsule-1", idempotencyKey: "recovery-1",
    }));

    const response = await getRecoveryIncidents(new Request("http://localhost"), { params: { appId } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].category).toBe("stale");
  });

  it("returns the guard's response when the admin lacks the permission", async () => {
    const { NextResponse } = await import("next/server");
    mocks.requireAdminApi.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) });
    const response = await getRecoveryIncidents(new Request("http://localhost"), { params: { appId } });
    expect(response.status).toBe(403);
  });
});
