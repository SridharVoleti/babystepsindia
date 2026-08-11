import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { composeLearnerHome } from "@/lib/learner-home/service";
import { resumeLearnerSession } from "@/lib/learning-session/gateway";

const now = new Date("2026-08-15T10:00:00.000Z");
const environment = "production";
const appId = "app-resumable";
const otherAppId = "app-other";
const sessionId = "session-resumable";
const deviceId = "device-original";
const credential = "resume-credential";
let parentId: string;
let learnerId: string;

function seedApp(app: string) {
  const bindingId = `binding-${app}`;
  const releaseId = `release-${app}`;
  const deploymentId = `deployment-${app}`;
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(app, app, app);
  getDb().prepare(`insert into app_deployment_bindings(id,app_id,environment,provider,provider_team_id,provider_project_id,
    expected_repository,binding_status) values(?,?,?,'vercel',?,?,'org/repo','verified')`)
    .run(bindingId, app, environment, `team-${app}`, `project-${app}`);
  getDb().prepare(`insert into app_releases(id,app_id,source_repository,source_commit_sha,dependency_lock_hash,build_input_hash,
    artifact_digest,manifest_json,gate_results_json,status,created_by_ci_principal)
    values(?,?,'org/repo',?,'lock','build','sha256:digest',?,'{}','verified','ci')`)
    .run(releaseId, app, `sha-${app}`, JSON.stringify({ manifestVersion: 1, appKey: app, launchPath: "/launch",
      returnPath: "/return", identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0" }));
  getDb().prepare(`insert into app_deployments(id,app_id,release_id,binding_id,environment,provider_deployment_id,
    verified_origin,status,published_at) values(?,?,?,?,?,?,?,'published',?)`)
    .run(deploymentId, app, releaseId, bindingId, environment, `provider-${app}`, `https://${app}.example.test`, now.toISOString());
  getDb().prepare(`insert into app_environment_publications(app_id,environment,current_published_deployment_id,version,published_at)
    values(?,?,?,1,?)`).run(app, environment, deploymentId, now.toISOString());
  getDb().prepare(`insert into app_deployment_launch_controls(deployment_id,app_id,release_id,environment,immutable_origin,
    launch_path,compatibility_status,status,updated_at) values(?,?,?,?,?,?,'passed','published',?)`)
    .run(deploymentId, app, releaseId, environment, `https://${app}.example.test`, "/launch", now.toISOString());
  applyPaidCycle({ paidCycleId: `cycle-${app}`, eventId: `event-${app}`, eventVersion: 1,
    subscriptionId: `subscription-${app}`, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: `product-${app}`, productVersion: 1, appIds: [app],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment, now });
  return { deploymentId, releaseId };
}

beforeEach(async () => {
  process.env.LEARNING_SESSION_SECRET = "ul002-session-secret-at-least-32-characters";
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul002-launcher-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01").learner.id;
});

describe("UL-002 launcher and original-device resume", () => {
  it("shows Resume only for the resumable app and blocks every other Start", () => {
    const deployment = seedApp(appId);
    seedApp(otherAppId);
    const entitlement = getDb().prepare(`select id from learner_app_effective_entitlements
      where learner_id=? and app_id=? and environment=?`).get(learnerId, appId, environment) as { id: string };
    const batch = getDb().prepare(`select id from learner_app_standard_credit_batches
      where learner_id=? and app_id=?`).get(learnerId, appId) as { id: string };
    getDb().prepare("update learner_app_standard_credit_batches set consumed_count=1 where id=?").run(batch.id);
    getDb().prepare(`insert into learner_sessions(id,learner_id,app_id,parent_user_id,parent_session_id,device_session_id,
      week_key,week_timezone,source,standard_credit_batch_id,weekly_session_ordinal,status,funding_state,
      schedule_authorization_id,started_at,usable_launch_established_at,hard_expires_at,resume_token_hash,
      deployment_id,release_id,deployment_environment,effective_entitlement_id,created_at,updated_at,
      intentional_exit_state,intentional_exit_reason,last_exit_acknowledged_progress_version,resumable_marked_at)
      values(?,?,?,?,?,?,'2026-W33','Asia/Kolkata','standard_monthly',?,1,'resumable','consumed','schedule-1',?,?,?,?,?,?,?,?,?,?,
      'resumable','intentional_resume_later',0,?)`).run(sessionId, learnerId, appId, parentId, "parent-session", deviceId,
        batch.id, new Date(now.getTime() - 600_000).toISOString(), new Date(now.getTime() - 600_000).toISOString(),
        new Date(now.getTime() + 3_000_000).toISOString(), createHash("sha256").update(credential).digest("hex"),
        deployment.deploymentId, deployment.releaseId, environment, entitlement.id,
        new Date(now.getTime() - 600_000).toISOString(), now.toISOString(), now.toISOString());

    const home = composeLearnerHome(learnerId, environment, now);
    expect(home.cards.find((card) => card.appId === appId)).toMatchObject({
      primaryAction: "resume", eligibility: { canStart: false, canResume: true },
      session: { activeOrResumableSession: { learnerSessionId: sessionId, status: "resumable" } },
    });
    expect(home.cards.find((card) => card.appId === otherAppId)).toMatchObject({
      primaryAction: "none", eligibility: { canStart: false, canResume: false, blockedReason: "another_app_in_progress" },
    });

    const before = getDb().prepare(`select consumed_count from learner_app_standard_credit_batches where id=?`).get(batch.id);
    const resumed = resumeLearnerSession({ grantId: "grant", principalId: "principal", learnerSessionId: sessionId,
      learnerId, appId }, { deviceSessionId: deviceId, credential, now: new Date(now.getTime() + 1_000) });
    expect(resumed).toMatchObject({ sessionId, status: "active", currentProgressVersion: 0 });
    expect(getDb().prepare(`select status,intentional_exit_state,intentional_exit_reason from learner_sessions where id=?`)
      .get(sessionId)).toMatchObject({ status: "active", intentional_exit_state: "none", intentional_exit_reason: null });
    expect(getDb().prepare(`select consumed_count from learner_app_standard_credit_batches where id=?`).get(batch.id)).toEqual(before);
  });

  it("rejects resume from another device without changing the durable resumable state", () => {
    const deployment = seedApp(appId);
    const entitlement = getDb().prepare(`select id from learner_app_effective_entitlements where learner_id=? and app_id=?`)
      .get(learnerId, appId) as { id: string };
    const batch = getDb().prepare(`select id from learner_app_standard_credit_batches where learner_id=? and app_id=?`)
      .get(learnerId, appId) as { id: string };
    getDb().prepare(`insert into learner_sessions(id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,
      source,standard_credit_batch_id,weekly_session_ordinal,status,funding_state,schedule_authorization_id,started_at,
      usable_launch_established_at,hard_expires_at,resume_token_hash,deployment_id,release_id,deployment_environment,
      effective_entitlement_id,created_at,updated_at,intentional_exit_state)
      values(?,?,?,?,?,'2026-W33','Asia/Kolkata','standard_monthly',?,1,'resumable','consumed','schedule-1',?,?,?,?,?,?,?,?,?,?,'resumable')`)
      .run(sessionId, learnerId, appId, parentId, deviceId, batch.id, now.toISOString(), now.toISOString(),
        new Date(now.getTime() + 3_000_000).toISOString(), createHash("sha256").update(credential).digest("hex"),
        deployment.deploymentId, deployment.releaseId, environment, entitlement.id, now.toISOString(), now.toISOString());
    expect(() => resumeLearnerSession({ grantId: "grant", principalId: "principal", learnerSessionId: sessionId,
      learnerId, appId }, { deviceSessionId: "other-device", credential, now })).toThrow("SESSION_RESUME_DEVICE_MISMATCH");
    expect(getDb().prepare("select status from learner_sessions where id=?").get(sessionId)).toMatchObject({ status: "resumable" });
  });
});
