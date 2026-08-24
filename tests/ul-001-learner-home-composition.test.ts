import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { composeLearnerHome } from "@/lib/learner-home/service";

const environment = "production";
const now = new Date("2026-08-15T00:00:00.000Z");
let parentId: string;
let learnerId: string;

function seedApp(appId: string, displayName = appId) {
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, displayName);
}

// Minimal, directly-fixture-constructed "published, healthy deployment" —
// bypasses the full AR-002 binding/release/staging/window pipeline (this
// composition layer only ever reads getPublishedDeployment(), it doesn't
// exercise the pipeline itself) — same fixture-construction precedent as
// EN-004's own tests use for states that are real but awkward to trigger
// organically end-to-end.
function publishApp(appId: string, environment: string) {
  const bindingId = `binding-${appId}`;
  const releaseId = `release-${appId}`;
  const deploymentId = `deployment-${appId}`;
  getDb().prepare(`insert into app_deployment_bindings(id,app_id,environment,provider,provider_team_id,provider_project_id,
    expected_repository,binding_status) values(?,?,?,'vercel',?,?,'org/repo','verified')`)
    .run(bindingId, appId, environment, `team-${appId}`, `proj-${appId}`);
  getDb().prepare(`insert into app_releases(id,app_id,source_repository,source_commit_sha,dependency_lock_hash,build_input_hash,
    artifact_digest,manifest_json,gate_results_json,status,created_by_ci_principal)
    values(?,?,'org/repo','sha1','lock1','build1','sha256:digest1',?,'{}','verified','ci-1')`)
    .run(releaseId, appId, JSON.stringify({ manifestVersion: 1, appKey: appId, launchPath: "/launch", returnPath: "/return",
      identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0" }));
  getDb().prepare(`insert into app_deployments(id,app_id,release_id,binding_id,environment,provider_deployment_id,
    verified_origin,status,published_at) values(?,?,?,?,?,?,?, 'published',?)`)
    .run(deploymentId, appId, releaseId, bindingId, environment, `provider-dep-${appId}`, `https://${appId}.example.test`, now.toISOString());
  getDb().prepare(`insert into app_environment_publications(app_id,environment,current_published_deployment_id,version,published_at)
    values(?,?,?,1,?)`).run(appId, environment, deploymentId, now.toISOString());
  getDb().prepare(`insert into app_deployment_launch_controls(deployment_id,app_id,release_id,environment,immutable_origin,
    launch_path,compatibility_status,status,updated_at) values(?,?,?,?,?,?,'passed','published',?)`)
    .run(deploymentId, appId, releaseId, environment, `https://${appId}.example.test`, "/launch", now.toISOString());
}

function seedActiveCycle(appId: string, opts: { periodStart?: string; periodEnd?: string; paidCycleId?: string } = {}) {
  return applyPaidCycle({
    paidCycleId: opts.paidCycleId ?? `cycle-${appId}`, eventId: `event-${appId}`, eventVersion: 1,
    subscriptionId: `sub-${appId}`, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: `product-${appId}`, productVersion: 1, appIds: [appId],
    periodStart: opts.periodStart ?? "2026-08-01T00:00:00.000Z", periodEnd: opts.periodEnd ?? "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment, now,
  });
}

function activeApp(appId: string, displayName = appId) {
  seedApp(appId, displayName);
  publishApp(appId, environment);
  seedActiveCycle(appId);
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul001-home-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

describe("composeLearnerHome — membership", () => {
  it("returns an empty card list when the learner has no entitlement periods at all", async () => {
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards).toEqual([]);
    expect(home.activeSession).toBeNull();
  });

  it("includes an active app exactly once, with app metadata sourced from app_registry (rule 8-9,11,17)", async () => {
    activeApp("app-a", "App Alpha");
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards).toHaveLength(1);
    expect(home.cards[0]).toMatchObject({ appId: "app-a", appName: "App Alpha", status: "active" });
  });

  it("excludes an app whose entitlement period has ended (rule 14)", async () => {
    seedApp("app-ended"); publishApp("app-ended", environment);
    seedActiveCycle("app-ended", { periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-07-01T00:00:00.000Z" });
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards).toEqual([]);
  });
});

describe("composeLearnerHome — EN-004 restoring access", () => {
  it("shows a neutral non-launchable card when integrity_state is repair_in_progress, without calling attemptLazyRepair", async () => {
    activeApp("app-repair");
    getDb().prepare(`update learner_app_effective_entitlements set integrity_state='repair_in_progress' where learner_id=? and app_id=?`)
      .run(learnerId, "app-repair");
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards).toHaveLength(1);
    expect(home.cards[0]).toMatchObject({ status: "restoring_access", primaryAction: "none",
      eligibility: { canStart: false, canResume: false, blockedReason: "restoring_access" } });
  });
});

describe("composeLearnerHome — deployment availability", () => {
  it("keeps a card visible but temporarily_unavailable when no deployment is published (rule 13)", async () => {
    seedApp("app-unpublished");
    seedActiveCycle("app-unpublished");
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards).toHaveLength(1);
    expect(home.cards[0]).toMatchObject({ status: "temporarily_unavailable", primaryAction: "none",
      eligibility: { blockedReason: "app_unavailable" } });
  });
});

describe("composeLearnerHome — PR-003/PR-004 progress gating", () => {
  it("shows learning_not_started with no fallback values when no summary row exists (rule 21-22)", async () => {
    activeApp("app-nosum");
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards[0]).toMatchObject({ progress: null, progressState: "learning_not_started" });
  });

  it("shows the PR-003 summary when present and PR-004 marks it safe", async () => {
    activeApp("app-sum");
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,progress_summary_json) values(?,?,?)`)
      .run(learnerId, "app-sum", JSON.stringify({ currentLevel: "L2", efficiencyStars: 3, milestone: null, nextDestination: "L3" }));
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards[0].progressState).toBe("summary_available");
    expect(home.cards[0].progress).toEqual({ currentLevel: "L2", efficiencyStars: 3, milestone: null, nextDestination: "L3" });
  });

  it("hides the summary with no invented fallback when PR-004 marks it unsafe (rule 24)", async () => {
    activeApp("app-unsafe");
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,progress_summary_json) values(?,?,?)`)
      .run(learnerId, "app-unsafe", JSON.stringify({ currentLevel: "L2", efficiencyStars: 3, milestone: null, nextDestination: "L3" }));
    getDb().prepare(`insert into learner_app_progress_integrity(learner_id,app_id,environment,integrity_state,integrity_version,
      issue_codes,mutation_blocked,read_safe,created_at,updated_at)
      values(?,?,?,'blocked_conflict',0,'[]',1,0,?,?)`)
      .run(learnerId, "app-unsafe", environment, now.toISOString(), now.toISOString());
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards[0]).toMatchObject({ progress: null, progressState: "summary_hidden_stale_or_blocked" });
  });
});

describe("composeLearnerHome — SC-002/LA-004 credit separation", () => {
  it("reports available standard sessions from SC-002 without merging in technical credits (rule 25-26)", async () => {
    activeApp("app-credits");
    getDb().prepare(`insert into learner_sessions(id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,
      source,status,funding_state,schedule_authorization_id,started_at,resume_token_hash,created_at,updated_at,weekly_slot_number)
      values(?,?,?,?,?,?,?,'normal','completed','consumed',?,?,?,?,?,1)`)
      .run("src-session", learnerId, "app-credits", parentId, "device-1", "2026-W33", "Asia/Kolkata", "auth-1",
        now.toISOString(), "hash-1", now.toISOString(), now.toISOString());
    getDb().prepare(`insert into learner_session_credits(id,source_learner_session_id,learner_id,app_id,credit_type,status,
      confirmed_by_actor_type,confirmed_by_actor_id,confirmation_reason_code,granted_at,expires_at,version,created_at,updated_at)
      values(?,?,?,?,'technical_replacement',?,'parent',?,'technical_issue',?,?,1,?,?)`).run(randomUUID(), "src-session",
      learnerId, "app-credits", "available", parentId, now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString(),
      now.toISOString(), now.toISOString());
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards[0].session.technicalCreditsAvailable).toBe(1);
    // applyPaidCycle already granted an independent 8-credit standard batch (EN-001) — the
    // technical credit above must not be folded into that count, proving the two stay separate.
    expect(home.cards[0].session.availableStandardSessions).toBe(8);
  });
});

describe("composeLearnerHome — cross-app session concurrency", () => {
  it("blocks starting other apps while one app owns the active session (rule 36-37)", async () => {
    activeApp("app-active-session");
    activeApp("app-other");
    getDb().prepare(`insert into learner_sessions(id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,
      source,status,funding_state,schedule_authorization_id,started_at,resume_token_hash,created_at,updated_at,weekly_slot_number)
      values(?,?,?,?,?,?,?,'normal','active','consumed',?,?,?,?,?,1)`)
      .run("session-1", learnerId, "app-active-session", parentId, "device-1", "2026-W33", "Asia/Kolkata", "auth-1",
        now.toISOString(), "hash-1", now.toISOString(), now.toISOString());
    const home = await composeLearnerHome(learnerId, environment, now);
    const active = home.cards.find((c) => c.appId === "app-active-session")!;
    const other = home.cards.find((c) => c.appId === "app-other")!;
    expect(active.primaryAction).toBe("resume");
    expect(active.session.activeOrResumableSession).toEqual({ learnerSessionId: "session-1", status: "active" });
    expect(other.primaryAction).toBe("none");
    expect(other.eligibility.blockedReason).toBe("another_app_in_progress");
    expect(home.activeSession).toEqual({ appId: "app-active-session", learnerSessionId: "session-1", status: "active" });
  });

  it("shows a starting reservation as blocked, not resumable, on its own app", async () => {
    activeApp("app-starting");
    getDb().prepare(`insert into learner_sessions(id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,
      source,status,funding_state,schedule_authorization_id,started_at,resume_token_hash,created_at,updated_at,weekly_slot_number)
      values(?,?,?,?,?,?,?,'normal','starting','reserved',?,?,?,?,?,1)`)
      .run("session-starting", learnerId, "app-starting", parentId, "device-1", "2026-W33", "Asia/Kolkata", "auth-1",
        now.toISOString(), "hash-1", now.toISOString(), now.toISOString());
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards[0].primaryAction).toBe("none");
    expect(home.cards[0].eligibility.blockedReason).toBe("starting_reservation_in_progress");
  });
});

describe("composeLearnerHome — per-app failure isolation", () => {
  it("isolates one app's throw so the rest of the batch still returns (rule 43-44)", async () => {
    activeApp("app-good");
    activeApp("app-ghost");
    // Simulate a genuinely inconsistent row (orphaned effective-entitlement
    // pointing at a since-removed app) the same way this codebase's own
    // schema-migration code disables FK enforcement to make a normally
    // FK-blocked state constructible for a test — evaluateAccessFresh then
    // throws RESOURCE_NOT_FOUND for app-ghost specifically.
    const db = getDb();
    db.pragma("foreign_keys = OFF");
    db.prepare("delete from app_registry where id=?").run("app-ghost");
    db.pragma("foreign_keys = ON");
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards.find((c) => c.appId === "app-good")).toMatchObject({ status: "active" });
    expect(home.cards.find((c) => c.appId === "app-ghost")).toMatchObject({ status: "error" });
  });
});

describe("composeLearnerHome — side effects", () => {
  it("writes nothing to sessions/credits/integrity-receipt tables (rule 30-31,46)", async () => {
    activeApp("app-readonly");
    const before = {
      sessions: (getDb().prepare("select count(*) as n from learner_sessions").get() as { n: number }).n,
      receipts: (getDb().prepare("select count(*) as n from progress_integrity_validation_receipts").get() as { n: number }).n,
      credits: (getDb().prepare("select count(*) as n from learner_session_credits").get() as { n: number }).n,
    };
    await composeLearnerHome(learnerId, environment, now);
    const after = {
      sessions: (getDb().prepare("select count(*) as n from learner_sessions").get() as { n: number }).n,
      receipts: (getDb().prepare("select count(*) as n from progress_integrity_validation_receipts").get() as { n: number }).n,
      credits: (getDb().prepare("select count(*) as n from learner_session_credits").get() as { n: number }).n,
    };
    expect(after).toEqual(before);
  });
});

describe("composeLearnerHome — deterministic sort", () => {
  it("sorts cards by app name (no display_order column exists)", async () => {
    activeApp("app-z", "Zeta");
    activeApp("app-a", "Alpha");
    const home = await composeLearnerHome(learnerId, environment, now);
    expect(home.cards.map((c) => c.appName)).toEqual(["Alpha", "Zeta"]);
  });
});

