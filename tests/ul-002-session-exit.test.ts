import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import {
  finishSessionIntentionally,
  getSessionExitState,
  markSessionResumable,
  SessionExitError,
} from "@/lib/session-exit/service";
import type { AppProgressContext } from "@/lib/app-progress/service";
import { sweepExpiredLearnerSessions } from "@/lib/learning-session/gateway";

const now = new Date("2026-08-11T10:00:00.000Z");
const sessionId = "session-ul002";
const appId = "app-ul002";
const deviceId = "device-ul002";
const resumeCredential = "resume-ul002";

let parentId: string;
let learnerId: string;

function context(): AppProgressContext {
  return { grantId: "grant-ul002", principalId: "principal-ul002", learnerSessionId: sessionId, learnerId, appId };
}

function seedActiveSession() {
  const hardExpiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  getDb().prepare(`insert into learner_sessions(id,learner_id,app_id,parent_user_id,parent_session_id,device_session_id,
    week_key,week_timezone,weekly_slot_number,source,status,funding_state,schedule_authorization_id,started_at,
    usable_launch_established_at,active_segment_started_at,hard_expires_at,connected_elapsed_seconds,
    verified_active_seconds,resume_token_hash,deployment_id,release_id,deployment_environment,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,'normal','active','consumed',?,?,?,?,?,120,120,?,?,?,?,?,?)`).run(
      sessionId, learnerId, appId, parentId, "parent-session", deviceId, "2026-W33", "Asia/Kolkata", 1,
      "schedule-1", new Date(now.getTime() - 600_000).toISOString(), new Date(now.getTime() - 600_000).toISOString(),
      new Date(now.getTime() - 120_000).toISOString(), hardExpiresAt,
      createHash("sha256").update(resumeCredential).digest("hex"), "deployment-ul002", "release-ul002",
      "production", new Date(now.getTime() - 600_000).toISOString(), new Date(now.getTime() - 120_000).toISOString(),
    );
  return hardExpiresAt;
}

beforeEach(async () => {
  process.env.ANALYTICS_HMAC_SECRET = "ul002-analytics-secret-at-least-32-characters";
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul002-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01").learner.id;
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "UL-002 App");
  getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,
    valid_from,valid_until,version) values('principal-ul002',?,'production','deployment-ul002','client-ul002','key-ul002',
    'active',?,?,1)`).run(appId, new Date(now.getTime() - 86_400_000).toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString());
  seedActiveSession();
});

describe("UL-002 exit-state and Resume later", () => {
  it("reads authoritative exit state without mutating the session", () => {
    const before = getDb().prepare("select status,version,intentional_exit_state from learner_sessions where id=?").get(sessionId);
    expect(getSessionExitState(context(), now)).toMatchObject({
      sessionId, sessionStatus: "active", sessionVersion: 1,
      lastAcknowledgedProgressVersion: 0, allowedActions: ["resume_later", "finish_now"],
    });
    expect(getDb().prepare("select status,version,intentional_exit_state from learner_sessions where id=?").get(sessionId))
      .toEqual(before);
  });

  it("marks the same session resumable while preserving funding, device and hard expiry", () => {
    const before = getDb().prepare(`select source,funding_state,weekly_slot_number,device_session_id,hard_expires_at,
      connected_elapsed_seconds from learner_sessions where id=?`).get(sessionId);
    const result = markSessionResumable(context(), {
      expectedSessionVersion: 1, lastAcknowledgedProgressVersion: 0, idempotencyKey: "resume-later-1",
    }, now);
    expect(result).toMatchObject({ sessionId, sessionStatus: "resumable", sessionVersion: 2,
      allowedActions: ["resume", "finish_now"] });
    expect(getDb().prepare(`select source,funding_state,weekly_slot_number,device_session_id,hard_expires_at,
      connected_elapsed_seconds from learner_sessions where id=?`).get(sessionId)).toEqual(before);
    expect(getDb().prepare(`select intentional_exit_state,intentional_exit_reason,
      last_exit_acknowledged_progress_version,resumable_marked_at from learner_sessions where id=?`).get(sessionId))
      .toMatchObject({ intentional_exit_state: "resumable", intentional_exit_reason: "intentional_resume_later",
        last_exit_acknowledged_progress_version: 0, resumable_marked_at: now.toISOString() });
    expect((getDb().prepare("select count(*) n from session_exit_transition_receipts").get() as { n: number }).n).toBe(1);

    expect(markSessionResumable(context(), {
      expectedSessionVersion: 1, lastAcknowledgedProgressVersion: 0, idempotencyKey: "resume-later-1",
    }, new Date(now.getTime() + 1_000))).toEqual(result);
    expect((getDb().prepare("select count(*) n from session_exit_transition_receipts").get() as { n: number }).n).toBe(1);
  });

  it("fails closed when the claimed checkpoint version is not acknowledged", () => {
    expect(() => markSessionResumable(context(), {
      expectedSessionVersion: 1, lastAcknowledgedProgressVersion: 4, idempotencyKey: "resume-later-stale",
    }, now)).toThrowError(new SessionExitError("FINAL_PROGRESS_NOT_ACKNOWLEDGED"));
    expect(getDb().prepare("select status,version from learner_sessions where id=?").get(sessionId))
      .toMatchObject({ status: "active", version: 1 });
  });

  it("rejects the hard-expiry boundary without extending the session", () => {
    const hardExpiry = new Date(now.getTime() + 3_600_000);
    expect(() => markSessionResumable(context(), {
      expectedSessionVersion: 1, lastAcknowledgedProgressVersion: 0, idempotencyKey: "resume-later-expired",
    }, hardExpiry)).toThrowError(new SessionExitError("SESSION_HARD_EXPIRED"));
    expect(getDb().prepare("select status,hard_expires_at from learner_sessions where id=?").get(sessionId))
      .toMatchObject({ status: "active", hard_expires_at: hardExpiry.toISOString() });
  });

  it("keeps the resumable lock only until the original hard expiry, then finalizes lazily", () => {
    markSessionResumable(context(), {
      expectedSessionVersion: 1, lastAcknowledgedProgressVersion: 0, idempotencyKey: "resume-later-sweep",
    }, now);
    expect(sweepExpiredLearnerSessions(new Date(now.getTime() + 3_600_000))).toBe(1);
    expect(getDb().prepare("select status,end_reason,funding_state from learner_sessions where id=?").get(sessionId))
      .toMatchObject({ status: "interrupted", end_reason: "session_hard_expired", funding_state: "consumed" });
  });
});

describe("UL-002 Finish now", () => {
  it("finalizes with acknowledged progress, retains consumed funding and records a safe receipt", () => {
    const result = finishSessionIntentionally(context(), {
      expectedSessionVersion: 1, finalProgressVersion: 0, reason: "intentional_finish", idempotencyKey: "finish-1",
    }, now);
    expect(result).toMatchObject({ sessionId, sessionStatus: "completed", status: "completed",
      endReasonCode: "intentional_finish", finalProgressVersion: 0, returnUrl: "/learning-session/return" });
    expect(getDb().prepare(`select status,end_reason,funding_state,intentional_exit_state,
      intentional_exit_reason,resume_token_hash from learner_sessions where id=?`).get(sessionId)).toMatchObject({
        status: "completed", end_reason: "intentional_finish", funding_state: "consumed",
        intentional_exit_state: "finalized", intentional_exit_reason: "intentional_finish", resume_token_hash: "",
      });
    const receipt = getDb().prepare(`select action,acknowledged_progress_version,response_json
      from session_exit_transition_receipts where learner_session_id=?`).get(sessionId) as Record<string, unknown>;
    expect(receipt).toMatchObject({ action: "finish_now", acknowledged_progress_version: 0 });
    expect(String(receipt.response_json)).not.toContain("currentState");

    const retry = finishSessionIntentionally(context(), {
      expectedSessionVersion: 1, finalProgressVersion: 0, reason: "intentional_finish", idempotencyKey: "finish-1",
    }, new Date(now.getTime() + 1_000));
    expect(retry).toEqual(result);
    expect((getDb().prepare("select count(*) n from session_exit_transition_receipts").get() as { n: number }).n).toBe(1);
  });
});
