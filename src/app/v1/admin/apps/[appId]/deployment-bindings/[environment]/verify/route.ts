import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { verifyBinding, type DeploymentBindingEnvironment } from "@/lib/deployment-binding/service";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";

export async function POST(request: Request, { params }: { params: { appId: string; environment: string } }) {
  const guard = await requireAdminApi("admin.deployment.bindings.verify");
  if (!guard.ok) return guard.response;

  try {
    const binding = await verifyBinding(
      {
        appId: params.appId,
        environment: params.environment as DeploymentBindingEnvironment,
        adminUserId: guard.session.sub,
        provider: resolveDeploymentProvider(),
      },
      new Date(),
    );
    return NextResponse.json(binding);
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
