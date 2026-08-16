import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";

export async function POST(request: Request, { params }: { params: { appId: string; releaseId: string } }) {
  const guard = await requireAdminApi("admin.deployment.release.deploy_staging");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`deployment-staging:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // deploy-staging has no required body fields beyond idempotencyKey
  }

  try {
    const result = await deployToStaging(
      { appId: params.appId, releaseId: params.releaseId, adminUserId: guard.session.sub, idempotencyKey: String(body.idempotencyKey ?? "") },
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
