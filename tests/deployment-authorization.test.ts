import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createAuthorizationPolicyBundle, activateAuthorizationPolicyBundle } from "@/lib/authorization/policy-bundles";
import {
  DeploymentAuthorizationError,
  mutateDeployment,
  preflightDeploymentAuthorization,
} from "@/lib/authorization/deployment-service";

const now = new Date("2026-08-06T10:00:00.000Z");
beforeEach(() => useInMemoryDb());

async function fixture() {
  const { user } = await sqliteAuthAdapter.signUp("deployment-admin@example.com", "CorrectHorse1!");
  getDb().prepare("update users set is_admin=1 where id=?").run(user.id);
  getDb().prepare("insert into admin_permissions(user_id,permission) values(?, 'deployment_manage')").run(user.id);
  const app = createApp(user.id, { appKey: "deployment-app", displayName: "Deployment App", idempotencyKey: crypto.randomUUID() });
  getDb().prepare(`insert into app_deployment_launch_controls
    (deployment_id,app_id,release_id,environment,immutable_origin,launch_path,compatibility_status,status,version,updated_at)
    values('dep-1',?, 'release-1','production','https://v1.example','/launch','passed','published',1,?)`).run(app.id, now.toISOString());
  const bundle = createAuthorizationPolicyBundle({ version: "1.0.0", sourceCommitSha: "a".repeat(40), now,
    rules: ["deployment.schedule", "deployment.reschedule", "deployment.cancel", "deployment.promote", "deployment.rollback"].map((actionKey) =>
      ({ actionKey, effect: "allow" as const, principalType: "administrator" as const, resourceType: "deployment" })) });
  activateAuthorizationPolicyBundle({ version: bundle.version, activatedBy: user.id, now });
  return { user, app };
}

describe("AU-001 deployment-window authorization", () => {
  it("schedules an exact app/release with a 60-minute drain and 45-minute window under the locked policy", async () => {
    const { user, app } = await fixture();
    const preflight = preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.schedule",
      appId: app.id, deploymentId: "dep-1", releaseId: "release-1", reauthenticatedAt: now, now });
    const result = mutateDeployment({ preflight, expectedVersion: 1, idempotencyKey: "schedule-1", now,
      startsAt: new Date("2026-08-06T12:00:00.000Z") });
    expect(result).toMatchObject({ version: 2, status: "published", drainStartsAt: "2026-08-06T11:00:00.000Z",
      deploymentWindowEndsAt: "2026-08-06T12:45:00.000Z" });
    expect(getDb().prepare("select operation from deployment_authorization_audit").get()).toMatchObject({ operation: "schedule" });
  });

  it("rejects stale reauthentication and missing deployment permission", async () => {
    const { user, app } = await fixture();
    expect(() => preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.schedule", appId: app.id,
      deploymentId: "dep-1", releaseId: "release-1", reauthenticatedAt: new Date(now.getTime() - 301_000), now }))
      .toThrowError(new DeploymentAuthorizationError("RECENT_REAUTHENTICATION_REQUIRED"));
    getDb().prepare("delete from admin_permissions where user_id=? and permission='deployment_manage'").run(user.id);
    expect(() => preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.schedule", appId: app.id,
      deploymentId: "dep-1", releaseId: "release-1", reauthenticatedAt: now, now }))
      .toThrowError(new DeploymentAuthorizationError("FORBIDDEN"));
  });

  it("fails when the active policy changes between preflight and the locked mutation", async () => {
    const { user, app } = await fixture();
    const preflight = preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.cancel",
      appId: app.id, deploymentId: "dep-1", releaseId: "release-1", reauthenticatedAt: now, now });
    const denied = createAuthorizationPolicyBundle({ version: "1.0.1", sourceCommitSha: "b".repeat(40), now,
      rules: [{ actionKey: "deployment.cancel", effect: "deny", principalType: "administrator", resourceType: "deployment" }] });
    activateAuthorizationPolicyBundle({ version: denied.version, activatedBy: user.id, now });
    expect(() => mutateDeployment({ preflight, expectedVersion: 1, idempotencyKey: "cancel-1", now }))
      .toThrowError(new DeploymentAuthorizationError("AUTHORIZATION_POLICY_CHANGED"));
    expect(getDb().prepare("select version from app_deployment_launch_controls where deployment_id='dep-1'").get())
      .toMatchObject({ version: 1 });
  });

  it("rejects foreign app/release bindings and stale row versions without mutation", async () => {
    const { user, app } = await fixture();
    expect(() => preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.schedule", appId: app.id,
      deploymentId: "dep-1", releaseId: "foreign-release", reauthenticatedAt: now, now }))
      .toThrowError(new DeploymentAuthorizationError("DEPLOYMENT_NOT_FOUND"));
    const preflight = preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.schedule", appId: app.id,
      deploymentId: "dep-1", releaseId: "release-1", reauthenticatedAt: now, now });
    expect(() => mutateDeployment({ preflight, expectedVersion: 99, idempotencyKey: "stale", now,
      startsAt: new Date("2026-08-06T12:00:00Z") })).toThrowError(new DeploymentAuthorizationError("DEPLOYMENT_VERSION_CONFLICT"));
  });

  it("replays identical requests and rejects an idempotency key reused for another operation", async () => {
    const { user, app } = await fixture();
    const preflight = preflightDeploymentAuthorization({ adminUserId: user.id, action: "deployment.schedule", appId: app.id,
      deploymentId: "dep-1", releaseId: "release-1", reauthenticatedAt: now, now });
    const input = { preflight, expectedVersion: 1, idempotencyKey: "same", now,
      startsAt: new Date("2026-08-06T12:00:00Z") };
    expect(mutateDeployment(input)).toEqual(mutateDeployment(input));
    expect(() => mutateDeployment({ ...input, startsAt: new Date("2026-08-07T12:00:00Z") }))
      .toThrowError(new DeploymentAuthorizationError("IDEMPOTENCY_KEY_REUSED"));
  });
});
