import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { createOrReplaceBinding, type DeploymentBindingEnvironment } from "@/lib/deployment-binding/service";

export async function PATCH(request: Request, { params }: { params: { appId: string; environment: string } }) {
  const guard = await requireAdminApi("admin.deployment.bindings.read");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  try {
    const binding = await createOrReplaceBinding({
      appId: params.appId,
      environment: params.environment as DeploymentBindingEnvironment,
      provider: String(body.provider ?? ""),
      providerTeamId: String(body.providerTeamId ?? ""),
      providerProjectId: String(body.providerProjectId ?? ""),
      expectedRepository: String(body.expectedRepository ?? ""),
      approvedDomainId: typeof body.approvedDomainId === "string" ? body.approvedDomainId : null,
      adminUserId: guard.session.sub,
      idempotencyKey: String(body.idempotencyKey ?? ""),
    });
    return NextResponse.json(binding);
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
