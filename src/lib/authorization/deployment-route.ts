import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getDb } from "@/lib/db/client";
import { mutateDeployment, preflightDeploymentAuthorization,
  DeploymentAuthorizationError, type DeploymentAction } from "@/lib/authorization/deployment-service";
import { requireOperationChangeForMutation, recordOperationOutcome } from "@/lib/operations-admin/service";
import { OperationChangeError, operationChangeErrorStatus } from "@/lib/operations-admin/contracts";

function errorStatus(code: string) {
  if (code === "DEPLOYMENT_NOT_FOUND") return 404;
  if (code === "RECENT_REAUTHENTICATION_REQUIRED") return 401;
  if (code === "FORBIDDEN") return 403;
  if (code === "DEPLOYMENT_VERSION_CONFLICT" || code === "AUTHORIZATION_POLICY_CHANGED"
    || code === "IDEMPOTENCY_KEY_REUSED" || code === "DEPLOYMENT_ACTIVE_SESSIONS") return 409;
  return 400;
}

// AD-004 rules 13, 43, 56-64, 94: every human deployment mutation
// (schedule/reschedule/cancel/promote) must reference an AD-004 operation
// record scoped to the exact app+environment being mutated — the operation
// record never itself authorizes the mutation (AR-002's own preflight/lock
// below is unchanged and still runs).
export async function handleDeploymentMutation(request: Request, params: { appId: string; deploymentId: string },
  action: DeploymentAction) {
  const guard = await requireAdminApi(action);
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`deployment:${action}:${guard.session.sub}`, 20, 5 * 60 * 1000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const now = new Date();
  const reauthFailure = requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;
  if (typeof body.operationChangeId !== "string" || !body.operationChangeId) {
    return NextResponse.json({ error: "OPERATION_CHANGE_REQUIRED" }, { status: 400 });
  }
  try {
    const releaseId = typeof body.releaseId === "string" ? body.releaseId : "";
    const preflight = preflightDeploymentAuthorization({ adminUserId: guard.principal.id, action,
      appId: params.appId, deploymentId: params.deploymentId, releaseId, reauthenticatedAt: now, now });
    const deploymentRow = getDb().prepare("select environment from app_deployments where id=?")
      .get(params.deploymentId) as { environment: string } | undefined;
    requireOperationChangeForMutation({ operationChangeId: body.operationChangeId,
      allowedTypes: ["release_promotion"], environment: deploymentRow?.environment ?? "production", appId: params.appId });
    const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : undefined;
    const result = mutateDeployment({ preflight, expectedVersion: Number(body.expectedVersion),
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "", now, startsAt });
    recordOperationOutcome(body.operationChangeId, guard.session.sub, `admin.deployment.${action}`,
      action === "deployment.promote" ? "executing" : "succeeded", params.deploymentId, now);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OperationChangeError) {
      return NextResponse.json({ error: error.code }, { status: operationChangeErrorStatus(error.code) });
    }
    if (error instanceof DeploymentAuthorizationError)
      return NextResponse.json({ error: error.code }, { status: errorStatus(error.code) });
    throw error;
  }
}
