import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { resolveDbClient } from "@/lib/db-client";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { rollbackProduction } from "@/lib/deployment-rollback/service";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";
import { requireOperationChangeForMutation, recordOperationOutcome } from "@/lib/operations-admin/service";
import { OperationChangeError, operationChangeErrorStatus } from "@/lib/operations-admin/contracts";

// AR-002 session 2, business rule 35: manual rollback uses the same
// automated path (src/lib/deployment-rollback/service.ts) as the ten-minute
// release-safety sweep, gated by app_deployment_promote + recent
// reauthentication — same permission family as production promotion
// itself. This URL was originally AU-001's own admin-notice scaffold
// (src/lib/authorization/deployment-service.ts, kept untouched — see that
// module's doc comment); this route now calls the real service directly
// instead, since that scaffold never actually promoted/rolled back a real
// provider deployment or touched the publication pointer.
export async function POST(request: Request, { params }: { params: { appId: string; deploymentId: string } }) {
  const guard = await requireAdminApi("admin.deployment.rollback");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`deployment-rollback:${guard.session.sub}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const reauthFailure = await requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  // AD-004 rules 13, 24, 64, 94: manual rollback is one of the named
  // high-impact human operations — requires an AD-004 operation record
  // scoped to this app+environment before AR-002's own rollback authority runs.
  if (typeof body.operationChangeId !== "string" || !body.operationChangeId) {
    return NextResponse.json({ error: "OPERATION_CHANGE_REQUIRED" }, { status: 400 });
  }
  try {
    const deploymentRow = await resolveDbClient().get<{ environment: string }>(
      "select environment from app_deployments where id=?", [params.deploymentId]);
    requireOperationChangeForMutation({ operationChangeId: body.operationChangeId,
      allowedTypes: ["manual_rollback"], environment: deploymentRow?.environment ?? "production", appId: params.appId });
    const result = await rollbackProduction(
      {
        appId: params.appId,
        deploymentId: params.deploymentId,
        adminUserId: guard.session.sub,
        idempotencyKey: String(body.idempotencyKey ?? ""),
        reason: typeof body.reason === "string" ? body.reason : undefined,
      },
      resolveDeploymentProvider(),
      new Date(),
    );
    recordOperationOutcome(body.operationChangeId, guard.session.sub, "admin.deployment.rollback", "succeeded",
      params.deploymentId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OperationChangeError) {
      return NextResponse.json({ error: error.code }, { status: operationChangeErrorStatus(error.code) });
    }
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
