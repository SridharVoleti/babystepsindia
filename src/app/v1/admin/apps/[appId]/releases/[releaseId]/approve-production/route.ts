import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { approveProduction } from "@/lib/deployment-production/service";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";

// AR-002 business rule 21: production promotion requires app_deployment_promote
// permission, recent administrator reauthentication, and explicit approval
// of a specific immutable release. No origin/productionUrl field is ever
// read from the request body (AC21-22) — approveProduction only accepts
// appId/releaseId/adminUserId/idempotencyKey/deploymentWindowId. Session 2,
// business rule 38: a scheduled deployment-windows/service.ts window is now
// required — there is no immediate unscheduled promotion path.
//
// The Vercel adapter's promote() polls the deployment to READY before the
// route returns — allow wall-clock for that plus the re-run health check.
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { appId: string; releaseId: string } }) {
  const guard = await requireAdminApi("admin.deployment.release.approve_production");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`deployment-approve-production:${guard.session.sub}`, 10, 5 * 60 * 1000)) {
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

  try {
    const result = await approveProduction(
      {
        appId: params.appId,
        releaseId: params.releaseId,
        adminUserId: guard.session.sub,
        idempotencyKey: String(body.idempotencyKey ?? ""),
        deploymentWindowId: String(body.deploymentWindowId ?? ""),
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
