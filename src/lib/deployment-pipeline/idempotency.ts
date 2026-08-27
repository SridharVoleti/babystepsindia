import { resolveDbClient } from "@/lib/db-client";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

// Shared actor+app-scoped idempotency ledger for every AR-002 pipeline
// operation (business rule 43) — same request-hash/receipt shape as
// app_registry_mutation_requests / entitlement_application_receipts.
// Callers running inside an outer resolveDbClient().transaction() get this
// function's own resolveDbClient() call resolved to that SAME transaction
// automatically (dbClientContext's AsyncLocalStorage) — no db param needed.
type OperationRow = { request_hash: string; status: string; safe_response_json: string | null };

export async function checkDeploymentIdempotency<T>(
  actorPrincipalId: string,
  idempotencyKey: string,
  hash: string,
): Promise<T | null> {
  const existing = await resolveDbClient().get<OperationRow>(
    `select request_hash, status, safe_response_json from deployment_operation_requests
     where actor_principal_id = ? and idempotency_key = ?`,
    [actorPrincipalId, idempotencyKey],
  );
  if (!existing) return null;
  if (existing.request_hash !== hash) throw new DeploymentPipelineError("IDEMPOTENCY_KEY_REUSED");
  if (existing.status !== "completed" || !existing.safe_response_json) {
    throw new DeploymentPipelineError("MUTATION_IN_PROGRESS");
  }
  return JSON.parse(existing.safe_response_json) as T;
}

export async function beginDeploymentOperation(input: {
  actorPrincipalId: string;
  appId: string;
  idempotencyKey: string;
  operation:
    | "bind"
    | "verify_binding"
    | "create_release"
    | "deploy_staging"
    | "approve_production"
    | "schedule_window"
    | "reschedule_window"
    | "cancel_window"
    | "rollback";
  hash: string;
}) {
  await resolveDbClient().run(
    `insert into deployment_operation_requests
     (actor_principal_id, app_id, idempotency_key, operation, request_hash, status)
     values (?, ?, ?, ?, ?, 'processing')`,
    [input.actorPrincipalId, input.appId, input.idempotencyKey, input.operation, input.hash],
  );
}

export async function completeDeploymentOperation(input: {
  actorPrincipalId: string;
  idempotencyKey: string;
  result: unknown;
  releaseId?: string | null;
  deploymentId?: string | null;
  resultId?: string | null;
  now?: Date;
}) {
  await resolveDbClient().run(
    `update deployment_operation_requests
     set status = 'completed', safe_response_json = ?, release_id = ?, deployment_id = ?, result_id = ?,
         completed_at = ?
     where actor_principal_id = ? and idempotency_key = ?`,
    [
      JSON.stringify(input.result),
      input.releaseId ?? null,
      input.deploymentId ?? null,
      input.resultId ?? null,
      (input.now ?? new Date()).toISOString(),
      input.actorPrincipalId,
      input.idempotencyKey,
    ],
  );
}
