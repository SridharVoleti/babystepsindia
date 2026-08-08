import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { purgeDeploymentArtifacts } from "@/lib/deployment-retention/service";

let ADMIN: string;
let appId: string;
let releaseId: string;
let bindingId: string;

const OLD = new Date("2020-01-01T00:00:00.000Z");
const NOW = new Date("2026-08-08T00:00:00.000Z");

function insertDeployment(overrides: Partial<{
  id: string; status: string; investigationHold: number; supersededAt: string | null; endedAt: string | null; startedAt: string;
}> = {}) {
  const id = overrides.id ?? randomUUID();
  getDb().prepare(
    `insert into app_deployments
     (id, app_id, release_id, binding_id, environment, provider_deployment_id, verified_origin, status,
      investigation_hold, started_at, superseded_at, ended_at)
     values (?, ?, ?, ?, 'production', ?, 'https://example.dev', ?, ?, ?, ?, ?)`,
  ).run(id, appId, releaseId, bindingId, `provider-${id}`, overrides.status ?? "superseded", overrides.investigationHold ?? 0,
    overrides.startedAt ?? OLD.toISOString(), overrides.supersededAt ?? OLD.toISOString(), overrides.endedAt ?? null);
  return id;
}

beforeEach(async () => {
  useInMemoryDb();
  ADMIN = (await sqliteAuthAdapter.signUp("retention-admin@example.com", "CorrectHorse1!")).user.id;
  const app = createApp(ADMIN, {
    appKey: "chess-master", displayName: "Chess Master", shortDescription: "desc", iconAssetKey: "icon-chess-piece",
    category: "learning", owningTeam: "platform", internalNotes: null, idempotencyKey: randomUUID(),
  });
  await activateApp(ADMIN, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  appId = app.id;

  bindingId = randomUUID();
  getDb().prepare(
    `insert into app_deployment_bindings
     (id, app_id, environment, provider, provider_team_id, provider_project_id, expected_repository, binding_status)
     values (?, ?, 'production', 'vercel', 'team', 'proj', 'babysteps/chess-master', 'verified')`,
  ).run(bindingId, appId);

  releaseId = randomUUID();
  getDb().prepare(
    `insert into app_releases
     (id, app_id, source_repository, source_commit_sha, dependency_lock_hash, build_input_hash, artifact_digest,
      manifest_json, gate_results_json, status, created_by_ci_principal)
     values (?, ?, 'babysteps/chess-master', 'commit-fixture', 'lock', 'build', 'sha256:fixture', '{}', '{}', 'promoted', 'ci-1')`,
  ).run(releaseId, appId);
});

describe("AR-002 session 2: deployment artifact retention", () => {
  it("purges an old superseded deployment not referenced by any publication pointer", () => {
    const id = insertDeployment({ status: "superseded" });

    const result = purgeDeploymentArtifacts(NOW);

    expect(result.deploymentsPurged).toBe(1);
    expect(getDb().prepare("select 1 from app_deployments where id = ?").get(id)).toBeUndefined();
  });

  // AC33-34/rule 41: current and previous-healthy deployments are retained
  // regardless of age or status.
  it("never purges a deployment still referenced by the publication pointer", () => {
    const currentId = insertDeployment({ status: "superseded" });
    const previousId = insertDeployment({ status: "superseded" });
    getDb().prepare(
      `insert into app_environment_publications (app_id, environment, current_published_deployment_id, previous_healthy_deployment_id, version, published_at)
       values (?, 'production', ?, ?, 1, ?)`,
    ).run(appId, currentId, previousId, OLD.toISOString());

    const result = purgeDeploymentArtifacts(NOW);

    expect(result.deploymentsPurged).toBe(0);
    expect(getDb().prepare("select 1 from app_deployments where id = ?").get(currentId)).toBeTruthy();
    expect(getDb().prepare("select 1 from app_deployments where id = ?").get(previousId)).toBeTruthy();
  });

  it("never purges a failed deployment under an open investigation hold", () => {
    const id = insertDeployment({ status: "failed", investigationHold: 1 });

    const result = purgeDeploymentArtifacts(NOW);

    expect(result.deploymentsPurged).toBe(0);
    expect(getDb().prepare("select 1 from app_deployments where id = ?").get(id)).toBeTruthy();
  });

  it("does not purge a recently superseded deployment still inside the retention window", () => {
    const id = insertDeployment({ status: "superseded", supersededAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() });

    const result = purgeDeploymentArtifacts(NOW);

    expect(result.deploymentsPurged).toBe(0);
    expect(getDb().prepare("select 1 from app_deployments where id = ?").get(id)).toBeTruthy();
  });

  it("purges the safety-observation and launch-controls rows alongside a purged deployment", () => {
    const id = insertDeployment({ status: "rolled_back", endedAt: OLD.toISOString() });
    getDb().prepare(
      "insert into app_deployment_safety_observations (deployment_id, app_id, started_at, status) values (?, ?, ?, 'rollback_triggered')",
    ).run(id, appId, OLD.toISOString());
    getDb().prepare(
      `insert into app_deployment_launch_controls (deployment_id, app_id, release_id, environment, immutable_origin, launch_path, compatibility_status, status, updated_at)
       values (?, ?, 'release-fixture', 'production', 'https://example.dev', '/launch', 'passed', 'retired', ?)`,
    ).run(id, appId, OLD.toISOString());

    purgeDeploymentArtifacts(NOW);

    expect(getDb().prepare("select 1 from app_deployment_safety_observations where deployment_id = ?").get(id)).toBeUndefined();
    expect(getDb().prepare("select 1 from app_deployment_launch_controls where deployment_id = ?").get(id)).toBeUndefined();
  });

  it("purges old completed deployment windows but not a still-blocking extended_safe_block window", () => {
    const completedId = randomUUID();
    const blockedId = randomUUID();
    getDb().prepare(
      `insert into app_deployment_windows (id, app_id, release_id, starts_at, ends_at, drain_starts_at, status, created_by_admin_id, completed_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(completedId, appId, releaseId, OLD.toISOString(), OLD.toISOString(), OLD.toISOString(), ADMIN, OLD.toISOString(), OLD.toISOString());
    getDb().prepare(
      `insert into app_deployment_windows (id, app_id, release_id, starts_at, ends_at, drain_starts_at, status, created_by_admin_id, updated_at)
       values (?, ?, ?, ?, ?, ?, 'extended_safe_block', ?, ?)`,
    ).run(blockedId, appId, releaseId, OLD.toISOString(), OLD.toISOString(), OLD.toISOString(), ADMIN, OLD.toISOString());

    const result = purgeDeploymentArtifacts(NOW);

    expect(result.windowsPurged).toBe(1);
    expect(getDb().prepare("select 1 from app_deployment_windows where id = ?").get(completedId)).toBeUndefined();
    expect(getDb().prepare("select 1 from app_deployment_windows where id = ?").get(blockedId)).toBeTruthy();
  });

  it("purges old processed webhook receipts and completed operation requests", () => {
    getDb().prepare(
      "insert into deployment_webhook_receipts (id, provider, provider_event_id, received_at, processed_at, status) values (?, 'vercel', 'evt-old', ?, ?, 'processed')",
    ).run(randomUUID(), OLD.toISOString(), OLD.toISOString());
    getDb().prepare(
      "insert into deployment_operation_requests (actor_principal_id, app_id, idempotency_key, operation, request_hash, status, created_at, completed_at) values (?, ?, ?, 'bind', 'hash', 'completed', ?, ?)",
    ).run(ADMIN, appId, randomUUID(), OLD.toISOString(), OLD.toISOString());

    const result = purgeDeploymentArtifacts(NOW);

    expect(result.webhookReceiptsPurged).toBe(1);
    expect(result.operationRequestsPurged).toBe(1);
  });
});
