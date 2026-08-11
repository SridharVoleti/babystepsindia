import { createHash, randomUUID } from "node:crypto";
import { DEPLOYMENT_ADMIN_AUTHORIZATION } from "@/lib/authorization/deployment-contract";
import type { AuthorizationAction } from "@/lib/authorization/modes";
import { getActiveAuthorizationPolicyBundle } from "@/lib/authorization/policy-bundles";
import { getDb } from "@/lib/db/client";

export type DeploymentAction = Extract<AuthorizationAction, `deployment.${string}`>;
type DeploymentRow = {
  deployment_id: string; app_id: string; release_id: string; environment: string;
  immutable_origin: string; launch_path: string; compatibility_status: string;
  drain_starts_at: string | null; deployment_window_ends_at: string | null;
  status: "published" | "draining" | "deploying" | "retired"; version: number; updated_at: string;
};
export type DeploymentAuthorizationPreflight = {
  adminUserId: string; action: DeploymentAction; appId: string; deploymentId: string; releaseId: string;
  reauthenticatedAt: string; policyVersion: string; policyDigest: string;
};

export class DeploymentAuthorizationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "DeploymentAuthorizationError"; }
}

function operation(action: DeploymentAction) { return action.slice("deployment.".length) as "schedule" | "reschedule" | "cancel" | "promote" | "rollback"; }
function deployment(appId: string, deploymentId: string, releaseId: string) {
  return getDb().prepare("select * from app_deployment_launch_controls where deployment_id=? and app_id=? and release_id=?")
    .get(deploymentId, appId, releaseId) as DeploymentRow | undefined;
}
function authorize(input: { adminUserId: string; action: DeploymentAction; appId: string; deploymentId: string;
  releaseId: string; reauthenticatedAt: Date; now: Date }) {
  const db = getDb();
  if (!db.prepare("select 1 from users where id=? and is_admin=1").get(input.adminUserId)
    || !db.prepare("select 1 from admin_permissions where user_id=? and permission='deployment_manage'").get(input.adminUserId))
    throw new DeploymentAuthorizationError("FORBIDDEN");
  const rule = DEPLOYMENT_ADMIN_AUTHORIZATION[input.action];
  const age = input.now.getTime() - input.reauthenticatedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > rule.recentReauthenticationSeconds * 1000)
    throw new DeploymentAuthorizationError("RECENT_REAUTHENTICATION_REQUIRED");
  if (!deployment(input.appId, input.deploymentId, input.releaseId))
    throw new DeploymentAuthorizationError("DEPLOYMENT_NOT_FOUND");
  const bundle = getActiveAuthorizationPolicyBundle();
  const allowed = bundle.rules.some((candidate) => candidate.actionKey === input.action && candidate.effect === "allow"
    && candidate.principalType === "administrator" && candidate.resourceType === "deployment");
  if (!allowed) throw new DeploymentAuthorizationError("FORBIDDEN");
  return bundle;
}

export function preflightDeploymentAuthorization(input: { adminUserId: string; action: DeploymentAction; appId: string;
  deploymentId: string; releaseId: string; reauthenticatedAt: Date; now?: Date }): DeploymentAuthorizationPreflight {
  const now = input.now ?? new Date();
  const bundle = authorize({ ...input, now });
  return { adminUserId: input.adminUserId, action: input.action, appId: input.appId, deploymentId: input.deploymentId,
    releaseId: input.releaseId, reauthenticatedAt: input.reauthenticatedAt.toISOString(), policyVersion: bundle.version,
    policyDigest: bundle.digest };
}

function result(row: DeploymentRow) {
  return { deploymentId: row.deployment_id, appId: row.app_id, releaseId: row.release_id, environment: row.environment,
    status: row.status, version: row.version, drainStartsAt: row.drain_starts_at,
    deploymentWindowEndsAt: row.deployment_window_ends_at, updatedAt: row.updated_at };
}

export function mutateDeployment(input: { preflight: DeploymentAuthorizationPreflight; expectedVersion: number;
  idempotencyKey: string; now?: Date; startsAt?: Date }) {
  const db = getDb(), now = input.now ?? new Date(), op = operation(input.preflight.action);
  if (!input.idempotencyKey.trim()) throw new DeploymentAuthorizationError("INVALID_REQUEST");
  const canonical = JSON.stringify({ action: input.preflight.action, appId: input.preflight.appId,
    deploymentId: input.preflight.deploymentId, releaseId: input.preflight.releaseId, expectedVersion: input.expectedVersion,
    startsAt: input.startsAt?.toISOString() ?? null });
  const requestHash = createHash("sha256").update(canonical).digest("hex");
  const run = db.transaction(() => {
    const receipt = db.prepare("select request_hash,status,response_json from deployment_mutation_requests where admin_user_id=? and idempotency_key=?")
      .get(input.preflight.adminUserId, input.idempotencyKey) as { request_hash: string; status: string; response_json: string | null } | undefined;
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new DeploymentAuthorizationError("IDEMPOTENCY_KEY_REUSED");
      if (receipt.status !== "completed" || !receipt.response_json) throw new DeploymentAuthorizationError("MUTATION_IN_PROGRESS");
      return JSON.parse(receipt.response_json) as ReturnType<typeof result>;
    }
    const activeBundle = getActiveAuthorizationPolicyBundle();
    if (activeBundle.version !== input.preflight.policyVersion || activeBundle.digest !== input.preflight.policyDigest)
      throw new DeploymentAuthorizationError("AUTHORIZATION_POLICY_CHANGED");
    const bundle = authorize({ adminUserId: input.preflight.adminUserId, action: input.preflight.action,
      appId: input.preflight.appId, deploymentId: input.preflight.deploymentId, releaseId: input.preflight.releaseId,
      reauthenticatedAt: new Date(input.preflight.reauthenticatedAt), now });
    const current = deployment(input.preflight.appId, input.preflight.deploymentId, input.preflight.releaseId)!;
    if (current.version !== input.expectedVersion) throw new DeploymentAuthorizationError("DEPLOYMENT_VERSION_CONFLICT");
    db.prepare(`insert into deployment_mutation_requests(admin_user_id,idempotency_key,operation,deployment_id,
      request_hash,status,created_at) values(?,?,?,?,?,'processing',?)`)
      .run(input.preflight.adminUserId, input.idempotencyKey, op, current.deployment_id, requestHash, now.toISOString());
    let drain: string | null = current.drain_starts_at, end: string | null = current.deployment_window_ends_at,
      status = current.status;
    if (op === "schedule" || op === "reschedule") {
      if (!input.startsAt || input.startsAt.getTime() < now.getTime() + 60 * 60 * 1000)
        throw new DeploymentAuthorizationError("DEPLOYMENT_WINDOW_INVALID");
      drain = new Date(input.startsAt.getTime() - 60 * 60 * 1000).toISOString();
      end = new Date(input.startsAt.getTime() + 45 * 60 * 1000).toISOString();
      status = "published";
    } else if (op === "cancel") { drain = null; end = null; status = "published"; }
    else {
      if (current.compatibility_status !== "passed") throw new DeploymentAuthorizationError("DEPLOYMENT_COMPATIBILITY_REQUIRED");
      const reserved = db.prepare(`select 1 from learner_sessions where app_id=? and deployment_environment=?
        and status in ('starting','active','disconnected','resumable') limit 1`).get(current.app_id, current.environment);
      const grant = db.prepare("select 1 from app_session_grants where app_id=? and environment=? and status='active' limit 1")
        .get(current.app_id, current.environment);
      if (reserved || grant) throw new DeploymentAuthorizationError("DEPLOYMENT_ACTIVE_SESSIONS");
      db.prepare("update app_deployment_launch_controls set status='retired',version=version+1,updated_at=? where app_id=? and environment=? and status='published' and deployment_id<>?")
        .run(now.toISOString(), current.app_id, current.environment, current.deployment_id);
      status = "published"; drain = null; end = null;
    }
    db.prepare(`update app_deployment_launch_controls set drain_starts_at=?,deployment_window_ends_at=?,status=?,
      version=version+1,updated_at=? where deployment_id=? and app_id=? and release_id=? and version=?`)
      .run(drain, end, status, now.toISOString(), current.deployment_id, current.app_id, current.release_id, current.version);
    const updated = deployment(current.app_id, current.deployment_id, current.release_id)!;
    const response = result(updated);
    db.prepare(`insert into deployment_authorization_audit(id,admin_user_id,app_id,deployment_id,release_id,operation,
      policy_version,policy_digest,version_from,version_to,created_at) values(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), input.preflight.adminUserId, current.app_id, current.deployment_id, current.release_id, op,
        bundle.version, bundle.digest, current.version, updated.version, now.toISOString());
    db.prepare(`update deployment_mutation_requests set status='completed',response_json=?,completed_at=?
      where admin_user_id=? and idempotency_key=?`).run(JSON.stringify(response), now.toISOString(),
        input.preflight.adminUserId, input.idempotencyKey);
    return response;
  });
  return run.immediate();
}
