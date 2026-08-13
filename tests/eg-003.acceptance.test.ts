// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { applyStandardSessionConsistency } from "@/lib/consistency/service";
import { readCadenceCompletionContext, composeCadenceCelebrationAfterCommit }
  from "@/lib/cadence-celebration/service";
import { CADENCE_CELEBRATION_API_CONTRACTS } from "@/lib/cadence-celebration/contracts";
import { finalizeLearnerSession, finalizeSessionAutomatically } from "@/lib/session-finalization/service";
import { finishSessionIntentionally } from "@/lib/session-exit/service";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";

let parentId: string;
let learnerId: string;
const appId = "app-math";
const releaseId = "release-eg003";
const week = "2026-W33";
const now = new Date("2026-08-12T10:00:00.000Z");
const manifest = { manifestVersion: 1, appKey: appId, launchPath: "/launch", returnPath: "/return",
  identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0",
  weeklyCadenceCelebration: { celebrationContextVersion: "1.0", accessibility: { immediateSkip: true,
    reducedMotion: true, keyboardNavigation: true, screenReaderText: true, mobileMinimumTargetCssPixels: 44 } } };

function seedRelease(raw: unknown = manifest) {
  getDb().prepare(`insert into app_releases(id,app_id,source_repository,source_commit_sha,dependency_lock_hash,
    build_input_hash,artifact_digest,manifest_json,gate_results_json,readable_schema_versions_json,status,
    created_by_ci_principal) values(?,?,'repo',?,'lock','input','digest',?,'{}','[]','verified','ci')`)
    .run(releaseId, appId, "a".repeat(40), JSON.stringify(raw));
}

function seedSession(ordinal: number, at: string, source = "standard_monthly", release: string | null = releaseId,
  suffix = "") {
  const id = `session-${ordinal}-${source}${suffix}`;
  getDb().prepare("update learner_sessions set status='interrupted' where learner_id=? and status='active'").run(learnerId);
  if (source === "standard_monthly") {
    getDb().prepare(`insert or ignore into learner_app_standard_credit_batches
      (id,learner_id,app_id,allocation_month,timezone,granted_count,reserved_count,consumed_count,effective_at,
       expires_at,version,created_at,updated_at) values('batch',?,?, '2026-08-01','Asia/Kolkata',8,0,0,
       '2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',1,?,?)`).run(learnerId, appId, at, at);
  }
  getDb().prepare(`insert into learner_sessions
    (id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,weekly_slot_number,source,
     standard_credit_batch_id,weekly_session_ordinal,status,funding_state,schedule_authorization_id,started_at,
     usable_launch_established_at,active_segment_started_at,hard_expires_at,resume_token_hash,deployment_environment,
     release_id,created_at,updated_at)
    values(?,?,?,?,?,?,? ,null,?,?,?,'active','consumed','schedule',?,?,?,?,'hash','production',?,?,?)`)
    .run(id, learnerId, appId, parentId, `device-${id}`, week, "Asia/Kolkata", source,
      source === "standard_monthly" ? "batch" : null, source === "standard_monthly" ? ordinal : null,
      at, at, at, new Date(new Date(at).getTime() + 3600_000).toISOString(), release, at, at);
  return id;
}

function contribute(sessionId: string, count: number) {
  getDb().prepare(`insert into learner_app_week_usage
    (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
    values(?,?,?,'Asia/Kolkata',0,?,?,?) on conflict(learner_id,app_id,week_key) do update set
    standard_sessions_funded=excluded.standard_sessions_funded,version=excluded.version,updated_at=excluded.updated_at`)
    .run(learnerId, appId, week, count, count, now.toISOString());
  return applyStandardSessionConsistency({ sourceSessionId: sessionId, weeklyUsageVersion: count,
    eventId: `standard-session:${sessionId}`, principalId: "session-domain", now });
}

function context(sessionId: string) {
  return { grantId: "grant", principalId: "app-principal", learnerSessionId: sessionId, learnerId, appId };
}

function finalize(sessionId: string, key = `complete-${sessionId}`) {
  const row = getDb().prepare("select version from learner_sessions where id=?").get(sessionId) as { version: number };
  const base = finalizeLearnerSession(context(sessionId), { expectedSessionVersion: row.version, finalProgressVersion: 0,
    endReasonCode: "learner_finished", completionIdempotencyKey: key, reportedConnectedSeconds: 60 }, now);
  return composeCadenceCelebrationAfterCommit(context(sessionId), key, base);
}

beforeEach(async () => {
  process.env.ANALYTICS_HMAC_SECRET = "eg003-test-secret-at-least-32-characters-long";
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`eg003-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01").learner.id;
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status)
    values(?,?,'Magical Math','active')`).run(appId, appId);
  getDb().prepare(`insert into app_service_principals
    (id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until)
    values('app-principal',?,'production','deployment','eg003-client','key','active',
      '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z')`).run(appId);
  seedRelease();
  getDb().prepare(`insert into entitlement_cycles
    (id,paid_cycle_id,subscription_id,purchaser_parent_id,assigned_learner_id,product_id,product_version,
     app_ids_json,period_start,period_end,billing_anchor,status,source_event_id,source_event_version,
     source_event_hash,created_at,ready_at,version)
    values('cycle','paid-cycle','subscription',?,?,'product',1,?,
      '2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-08-01','ready','event',1,
      'hash','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',1)`)
    .run(parentId, learnerId, JSON.stringify([appId]));
  getDb().prepare(`insert into learner_app_entitlement_periods
    (id,entitlement_cycle_id,subscription_id,learner_id,app_id,product_version,period_start,period_end,status,
     effective_source_role,created_at)
    values('period','cycle','subscription',?,?,1,'2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',
      'ready','allocation_bearing','2026-08-01T00:00:00.000Z')`).run(learnerId, appId);
});

describe("EG-003 app-specific cadence completion celebration", () => {
  it("AT-EG-003-01..12 emits only after the exact second qualifying session is finalized", () => {
    const first = seedSession(1, "2026-08-11T09:00:00.000Z"); contribute(first, 1);
    expect(readCadenceCompletionContext(appId, first)).toEqual({ eligible: false });
    const second = seedSession(2, "2026-08-12T09:00:00.000Z"); contribute(second, 2);
    expect(readCadenceCompletionContext(appId, second)).toEqual({ eligible: false });
    const result = finalize(second);
    expect(result).toMatchObject({ status: "completed", cadenceCelebrationContext: { eligible: true,
      weeklyKey: week, cadenceTarget: 2, completedSessions: 2, currentStreakWeeks: 1,
      longestStreakWeeks: 1, appRef: { appId, appKey: appId, displayName: "Magical Math" },
      celebrationContextVersion: "1.0" } });
    getDb().prepare("update learner_sessions set status='completed',ended_at=? where id=?")
      .run(now.toISOString(), first);
    expect(readCadenceCompletionContext(appId, first)).toEqual({ eligible: false });
  });

  it("AT-EG-003-13..18 is server-derived, app-scoped, safe, and retry-stable", () => {
    const first = seedSession(1, "2026-08-11T09:00:00.000Z"); contribute(first, 1);
    const second = seedSession(2, "2026-08-12T09:00:00.000Z"); contribute(second, 2);
    const result = finalize(second, "stable");
    const retryBase = finalizeLearnerSession(context(second), { expectedSessionVersion: 1, finalProgressVersion: 0,
      endReasonCode: "learner_finished", completionIdempotencyKey: "stable", reportedConnectedSeconds: 60 }, now);
    expect(composeCadenceCelebrationAfterCommit(context(second), "stable", retryBase)).toEqual(result);
    const payload = JSON.stringify(result);
    expect(payload).not.toMatch(/answer|mastery|payment|funding|sibling|credential|token|email/i);
    expect(() => readCadenceCompletionContext("other-app", second)).toThrowError("CONSISTENCY_RESOURCE_NOT_FOUND");
  });

  it("AT-EG-003-19..24 makes context failure nonblocking and suppresses undeclared releases", () => {
    getDb().prepare("update app_releases set manifest_json=? where id=?")
      .run(JSON.stringify({ ...manifest, weeklyCadenceCelebration: undefined }), releaseId);
    const first = seedSession(1, "2026-08-11T09:00:00.000Z"); contribute(first, 1);
    const second = seedSession(2, "2026-08-12T09:00:00.000Z"); contribute(second, 2);
    const result = finalize(second);
    expect(result).toMatchObject({ status: "completed" });
    expect(result).not.toHaveProperty("cadenceCelebrationContext");
    expect(getDb().prepare("select status from learner_sessions where id=?").get(second)).toEqual({ status: "completed" });
  });

  it("AT-EG-003-25..31 excludes technical, catch-up, and hard-expiry completion paths", () => {
    const first = seedSession(1, "2026-08-11T09:00:00.000Z"); contribute(first, 1);
    const second = seedSession(2, "2026-08-12T09:00:00.000Z"); contribute(second, 2); finalize(second);
    const third = seedSession(3, "2026-08-13T09:00:00.000Z");
    getDb().prepare("update learner_sessions set status='completed',ended_at=? where id=?").run(now.toISOString(), third);
    expect(readCadenceCompletionContext(appId, third)).toEqual({ eligible: false });
    getDb().prepare(`insert into learner_session_credits
      (id,source_learner_session_id,learner_id,app_id,credit_type,status,confirmed_by_actor_type,
       confirmed_by_actor_id,confirmation_reason_code,granted_at,expires_at,reserved_session_id,reserved_at,
       consumed_at,created_at,updated_at)
      values('technical-credit',?,?,?,'technical_replacement','consumed','parent',?,'technical_issue',
        ?,?,?, ?,?,?,?)`).run(first, learnerId, appId, parentId, now.toISOString(),
        "2026-09-01T00:00:00.000Z", third, now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());
    getDb().prepare(`update learner_sessions set source='technical_credit',standard_credit_batch_id=null,
      weekly_session_ordinal=null,session_credit_id='technical-credit' where id=?`).run(third);
    expect(readCadenceCompletionContext(appId, third)).toEqual({ eligible: false });
    const auto = seedSession(3, "2026-08-13T11:00:00.000Z", "standard_monthly", releaseId, "-auto");
    expect(finalizeSessionAutomatically(auto, "time_limit_reached", now)).not.toHaveProperty("cadenceCelebrationContext");
  });

  it("allows intentional Finish now to celebrate only after its outer transaction commits", () => {
    const first = seedSession(1, "2026-08-11T09:00:00.000Z"); contribute(first, 1);
    const second = seedSession(2, "2026-08-12T09:00:00.000Z"); contribute(second, 2);
    getDb().prepare("update learner_sessions set hard_expires_at='2026-08-12T11:00:00.000Z' where id=?").run(second);
    const result = finishSessionIntentionally(context(second), { expectedSessionVersion: 1, finalProgressVersion: 0,
      reason: "intentional_finish", idempotencyKey: "finish-context" }, new Date("2026-08-12T10:01:00.000Z"));
    expect(result).not.toHaveProperty("cadenceCelebrationContext");
    expect(composeCadenceCelebrationAfterCommit(context(second), "finish-context", result))
      .toHaveProperty("cadenceCelebrationContext.eligible", true);
  });

  it("AT-EG-003-32..40 adds no reward authority, history API, polling, or generic platform UI", () => {
    expect(CADENCE_CELEBRATION_API_CONTRACTS.context).toMatchObject({ id: "API-EG-013", method: "GET" });
    expect(CADENCE_CELEBRATION_API_CONTRACTS.completion).toMatchObject({ id: "API-EG-014", method: "AMEND" });
    expect(AUTHORIZATION_ACTIONS["service.consistency.context.read"]).toMatchObject({ mode: "service" });
    expect(resolveApiRouteAuthorization("GET",
      `/v1/internal/learner-consistency/${appId}/cadence-completion-context`)).toBe("service.consistency.context.read");
    expect(getDb().prepare(`select name from sqlite_master where type='table' and
      (name like '%celebration%' or name like '%reward%' or name like '%leaderboard%')`).all()).toEqual([]);
    const source = JSON.stringify(CADENCE_CELEBRATION_API_CONTRACTS);
    expect(source).not.toMatch(/poll|realtime|admin|parent|reward|credit|xp|leaderboard/i);
  });
});
