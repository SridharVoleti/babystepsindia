// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { saveCheckpoint, type AppProgressContext } from "@/lib/app-progress/service";
import { computeCanonicalStateHash } from "@/lib/progress-integrity/service";
import {
  ProgressRecoveryError,
  recoverCurrentProgress,
  closeRecoveryWindow,
  reconcileRecoveryReceipt,
  type RecoverCurrentProgressInput,
} from "@/lib/progress-recovery/service";

const now = new Date("2026-08-10T10:00:00.000Z");
const appId = "app-1";
const releaseId = "release-1";
const deploymentId = "deployment-1";
const environment = "production";
const deviceSessionId = "device-1";
const credential = "resume-credential-1";
const resumeTokenHash = createHash("sha256").update(credential).digest("hex");
const principalId = "principal-1";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  const schema = JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
  getDb().prepare(`insert into app_progress_schemas(app_id,release_id,schema_version,schema_json,schema_digest,status,created_at)
    values(?,?,1,?,?,'active',?)`).run(appId, releaseId, schema, createHash("sha256").update(schema).digest("hex"), now.toISOString());
});

async function createLearnerFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr002recovery-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner;
  return { user, learner };
}

function insertActiveSession(sessionId: string, learnerId: string, parentUserId: string,
  overrides: Record<string, unknown> = {}) {
  const base = {
    id: sessionId, learner_id: learnerId, app_id: appId, parent_user_id: parentUserId,
    parent_session_id: "parent-session-1", device_session_id: deviceSessionId,
    week_key: "2026-W32", week_timezone: "Asia/Kolkata", weekly_slot_number: 1, source: "normal",
    status: "active", schedule_authorization_id: "schedule-1", started_at: now.toISOString(),
    resume_token_hash: resumeTokenHash, deployment_id: deploymentId, release_id: releaseId,
    deployment_environment: environment, hard_expires_at: "2026-08-10T11:00:00.000Z",
    created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  const merged = { ...base, ...overrides };
  const columns = Object.keys(merged);
  getDb().prepare(`insert into learner_sessions(${columns.join(",")}) values(${columns.map(() => "?").join(",")})`)
    .run(...columns.map((key) => merged[key as keyof typeof merged]));
}

function context(sessionId: string, learnerId: string): AppProgressContext {
  return { grantId: "grant-1", principalId, learnerSessionId: sessionId, learnerId, appId };
}

async function seedInitialProgress(sessionId: string, learnerId: string) {
  getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
    values(?,?,?,?,?,?,'active',?,?,1)`).run(principalId, appId, environment, deploymentId, "client-1", "test-key",
    "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  getDb().prepare(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values('grant-1',?,?,?,?,?,?,?,'["progress.read","progress.write","progress.recover"]','1.0',1,'active',?,?,?)`)
    .run(sessionId, learnerId, appId, environment, deploymentId, releaseId, principalId,
      "2026-08-10T11:00:00.000Z", now.toISOString(), now.toISOString());
  return await saveCheckpoint(context(sessionId, learnerId), {
    expectedProgressVersion: 0, checkpointSequence: 1, stateSchemaVersion: 1,
    currentLevelKey: "level-1", currentLessonKey: "lesson-1", currentState: { level: "l1" },
    checkpointIdempotencyKey: "checkpoint-1",
  }, now);
}

function recoveryInput(overrides: Partial<RecoverCurrentProgressInput> = {}): RecoverCurrentProgressInput {
  return {
    deviceSessionId, credential, expectedProgressVersion: 1, baseStateHash: "",
    recoverySequence: 1, stateSchemaVersion: 1, pendingState: { level: "l1-pending" },
    recoveryCapsuleId: "capsule-1", idempotencyKey: "recovery-1",
    ...overrides,
  };
}

describe("PR-002 recoverCurrentProgress", () => {
  it("recovers pending state, bumping progress_version exactly once, level/lesson unchanged (rules 39-42)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    const seeded = await seedInitialProgress(sessionId, learner.id);
    expect(seeded.progressVersion).toBe(1);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;

    const result = await recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash }), now);
    expect(result.result).toBe("recovered");
    expect(result.newProgressVersion).toBe(2);

    const row = getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as Record<string, unknown>;
    expect(row.progress_version).toBe(2);
    expect(row.state_hash).toBe(result.newStateHash);
    expect(row.current_level_key).toBe("level-1");
    expect(row.current_lesson_key).toBe("lesson-1");
    expect(JSON.parse(row.current_state_json as string)).toEqual({ level: "l1-pending" });

    const session = getDb().prepare("select last_acknowledged_progress_version,last_acknowledged_progress_hash from learner_sessions where id=?")
      .get(sessionId) as { last_acknowledged_progress_version: number; last_acknowledged_progress_hash: string };
    expect(session.last_acknowledged_progress_version).toBe(2);
    expect(session.last_acknowledged_progress_hash).toBe(result.newStateHash);
  });

  it("rejects a stale base version/hash without mutating progress (rules 27-28, 36)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);

    await expect(recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: "wrong-hash" }), now)).rejects.toThrowError(new ProgressRecoveryError("PROGRESS_RECOVERY_STALE"));
    const row = getDb().prepare("select progress_version from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { progress_version: number };
    expect(row.progress_version).toBe(1);
    const incident = getDb().prepare("select category from progress_recovery_incidents where learner_session_id=?")
      .get(sessionId) as { category: string };
    expect(incident.category).toBe("stale");
  });

  it("rejects a non-monotonic recovery sequence (rule 48)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;

    await recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash, recoverySequence: 3, idempotencyKey: "r1" }), now);

    const newHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await expect(recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 2, baseStateHash: newHash, recoverySequence: 2, idempotencyKey: "r2" }), now)).rejects.toThrowError(new ProgressRecoveryError("PROGRESS_RECOVERY_SEQUENCE_CONFLICT"));
  });

  it("rejects at or after hard expiry (rules 22-23)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id, { hard_expires_at: "2026-08-10T10:00:00.000Z" });
    await seedInitialProgress(sessionId, learner.id);
    await expect(recoverCurrentProgress(context(sessionId, learner.id), recoveryInput(), now)).rejects.toThrowError(new ProgressRecoveryError("SESSION_HARD_EXPIRED"));
  });

  it("rejects a device mismatch (rule 17)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    await expect(recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ deviceSessionId: "different-device" }), now)).rejects.toThrowError(new ProgressRecoveryError("SESSION_DEVICE_MISMATCH"));
  });

  it("rejects an invalid resume credential independently of resume itself (decision 3)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    await expect(recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ credential: "wrong-credential" }), now)).rejects.toThrowError(new ProgressRecoveryError("SESSION_RESUME_PROOF_INVALID"));
  });

  it("rejects when integrity is not healthy, without mutating progress (rules 66-67)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    // Tamper the stored hash directly to force unreadable_corrupt.
    getDb().prepare("update learner_app_progress set state_hash='tampered' where learner_id=? and app_id=?")
      .run(learner.id, appId);
    await expect(recoverCurrentProgress(context(sessionId, learner.id), recoveryInput(), now)).rejects.toThrowError(new ProgressRecoveryError("PROGRESS_INTEGRITY_BLOCKED"));
    const row = getDb().prepare("select progress_version from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { progress_version: number };
    expect(row.progress_version).toBe(1);
  });

  it("rejects when the submitted schema version isn't registered (rule 33)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await expect(recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash, stateSchemaVersion: 99 }), now)).rejects.toThrowError(new ProgressRecoveryError("PROGRESS_MIGRATION_REQUIRED"));
  });

  it("replays an exact retry with the same idempotency key instead of re-mutating (rule 46)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    const input = recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash });
    const first = await recoverCurrentProgress(context(sessionId, learner.id), input, now);
    const second = await recoverCurrentProgress(context(sessionId, learner.id), input, now);
    expect(second).toEqual(first);
    const row = getDb().prepare("select progress_version from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { progress_version: number };
    expect(row.progress_version).toBe(2);
  });

  it("rejects conflicting idempotency-key reuse (rule 47)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash, idempotencyKey: "shared" }), now);
    await expect(recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash, idempotencyKey: "shared",
        pendingState: { level: "different" } }), now)).rejects.toThrowError(new ProgressRecoveryError("IDEMPOTENCY_KEY_REUSED"));
  });

  it("persists a receipt with no raw pendingState field at all (rule 45)", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash }), now);
    const receipt = getDb().prepare("select * from progress_recovery_receipts where learner_session_id=?").get(sessionId) as
      Record<string, unknown>;
    expect(Object.keys(receipt)).not.toContain("pending_state");
    expect(Object.keys(receipt)).not.toContain("current_state_json");
    expect(receipt.result).toBe("recovered");
  });
});

describe("PR-002 closeRecoveryWindow", () => {
  it("sets recovery_closed_at/reason exactly once", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await closeRecoveryWindow(sessionId, "hard_expired", now);
    const first = getDb().prepare("select recovery_closed_at,recovery_closed_reason from learner_sessions where id=?")
      .get(sessionId) as { recovery_closed_at: string; recovery_closed_reason: string };
    expect(first.recovery_closed_reason).toBe("hard_expired");
    await closeRecoveryWindow(sessionId, "secure_exit", new Date(now.getTime() + 60_000));
    const second = getDb().prepare("select recovery_closed_at,recovery_closed_reason from learner_sessions where id=?")
      .get(sessionId) as { recovery_closed_at: string; recovery_closed_reason: string };
    expect(second.recovery_closed_reason).toBe("hard_expired");
    expect(second.recovery_closed_at).toBe(first.recovery_closed_at);
  });
});

describe("PR-002 reconcileRecoveryReceipt", () => {
  it("confirms a receipt that matches the current stored progress row, accepting no payload input", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash }), now);
    const receipt = getDb().prepare("select id from progress_recovery_receipts where learner_session_id=?").get(sessionId) as
      { id: string };
    const result = await reconcileRecoveryReceipt(receipt.id, now);
    expect(result.confirmed).toBe(true);
  });

  it("flags an incomplete receipt when stored progress no longer matches, and throws for an unknown receipt", async () => {
    const { user, learner } = await createLearnerFixture();
    const sessionId = "session-1";
    insertActiveSession(sessionId, learner.id, user.id);
    await seedInitialProgress(sessionId, learner.id);
    const baseHash = (getDb().prepare("select state_hash from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { state_hash: string }).state_hash;
    await recoverCurrentProgress(context(sessionId, learner.id),
      recoveryInput({ expectedProgressVersion: 1, baseStateHash: baseHash }), now);
    const receipt = getDb().prepare("select id from progress_recovery_receipts where learner_session_id=?").get(sessionId) as
      { id: string };
    getDb().prepare("update learner_app_progress set progress_version=99 where learner_id=? and app_id=?").run(learner.id, appId);
    const result = await reconcileRecoveryReceipt(receipt.id, now);
    expect(result.confirmed).toBe(false);
    const incident = getDb().prepare("select category from progress_recovery_incidents where learner_session_id=? and category='incomplete_receipt'")
      .get(sessionId) as { category: string } | undefined;
    expect(incident?.category).toBe("incomplete_receipt");

    await expect(reconcileRecoveryReceipt("missing", now)).rejects.toThrowError(
      new ProgressRecoveryError("PROGRESS_RECOVERY_RECEIPT_NOT_FOUND"));
  });
});

