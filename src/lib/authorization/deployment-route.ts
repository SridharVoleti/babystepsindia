import { NextResponse } from "next/server";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { mutateDeployment, preflightDeploymentAuthorization,
  DeploymentAuthorizationError, type DeploymentAction } from "@/lib/authorization/deployment-service";

function errorStatus(code: string) {
  if (code === "DEPLOYMENT_NOT_FOUND") return 404;
  if (code === "RECENT_REAUTHENTICATION_REQUIRED") return 401;
  if (code === "FORBIDDEN") return 403;
  if (code === "DEPLOYMENT_VERSION_CONFLICT" || code === "AUTHORIZATION_POLICY_CHANGED"
    || code === "IDEMPOTENCY_KEY_REUSED" || code === "DEPLOYMENT_ACTIVE_SESSIONS") return 409;
  return 400;
}

export async function handleDeploymentMutation(request: Request, params: { appId: string; deploymentId: string },
  action: DeploymentAction) {
  const guard = await requireAdminApi("deployment_manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`deployment:${action}:${guard.session.sub}`, 20, 5 * 60 * 1000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const now = new Date();
  if (!(await verifyReauth(guard.session.email, currentPassword)))
    return NextResponse.json({ error: "RECENT_REAUTHENTICATION_REQUIRED" }, { status: 401 });
  try {
    const releaseId = typeof body.releaseId === "string" ? body.releaseId : "";
    const preflight = preflightDeploymentAuthorization({ adminUserId: guard.principal.id, action,
      appId: params.appId, deploymentId: params.deploymentId, releaseId, reauthenticatedAt: now, now });
    const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : undefined;
    const result = mutateDeployment({ preflight, expectedVersion: Number(body.expectedVersion),
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "", now, startsAt });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeploymentAuthorizationError)
      return NextResponse.json({ error: error.code }, { status: errorStatus(error.code) });
    throw error;
  }
}
