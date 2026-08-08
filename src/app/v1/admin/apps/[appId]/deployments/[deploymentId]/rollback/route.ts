import { NextResponse } from "next/server";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { rollbackProduction } from "@/lib/deployment-rollback/service";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";

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
  const guard = await requireAdminApi("app_deployment_promote");
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

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!(await verifyReauth(guard.session.email, currentPassword))) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }

  try {
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
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
