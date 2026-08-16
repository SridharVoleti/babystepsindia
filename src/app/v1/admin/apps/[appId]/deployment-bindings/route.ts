import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { createOrReplaceBinding, listBindings, type DeploymentBindingEnvironment } from "@/lib/deployment-binding/service";

const ENVIRONMENTS: DeploymentBindingEnvironment[] = ["development", "staging", "production"];

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.deployment.bindings.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ bindings: listBindings(params.appId) });
}

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.deployment.bindings.create");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`deployment-binding-create:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const environment = ENVIRONMENTS.includes(body.environment as DeploymentBindingEnvironment)
    ? (body.environment as DeploymentBindingEnvironment)
    : undefined;
  if (!environment) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });

  // AC5/AC21-22: the create payload only ever accepts a provider-discovered
  // project selection — no origin/productionUrl/launchOrigin field exists
  // on this schema at all, so there is nothing for an admin to override.
  try {
    const binding = createOrReplaceBinding({
      appId: params.appId,
      environment,
      provider: String(body.provider ?? ""),
      providerTeamId: String(body.providerTeamId ?? ""),
      providerProjectId: String(body.providerProjectId ?? ""),
      expectedRepository: String(body.expectedRepository ?? ""),
      approvedDomainId: typeof body.approvedDomainId === "string" ? body.approvedDomainId : null,
      adminUserId: guard.session.sub,
      idempotencyKey: String(body.idempotencyKey ?? ""),
    });
    return NextResponse.json(binding, { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
