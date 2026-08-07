import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { createRelease } from "@/lib/deployment-release/service";

// AR-002 business rule 11: only an authenticated CI/deployment service
// principal can create a release — this is the sole write path onto
// app_releases; there is no admin/browser endpoint that does the same.
export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireInternalService(request, "ci-deployer");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const gateResults = body.gateResults as Record<string, unknown> | undefined;
  if (!gateResults) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });

  try {
    const release = createRelease({
      appId: params.appId,
      sourceRepository: String(body.sourceRepository ?? ""),
      sourceCommitSha: String(body.sourceCommitSha ?? ""),
      dependencyLockHash: String(body.dependencyLockHash ?? ""),
      buildInputHash: String(body.buildInputHash ?? ""),
      artifactDigest: String(body.artifactDigest ?? ""),
      providerArtifactId: typeof body.providerArtifactId === "string" ? body.providerArtifactId : null,
      manifest: body.manifest,
      gateResults: {
        dependencyInstall: !!gateResults.dependencyInstall,
        typeCheck: !!gateResults.typeCheck,
        lint: !!gateResults.lint,
        unitTests: !!gateResults.unitTests,
        contractTests: !!gateResults.contractTests,
        security: !!gateResults.security,
        build: !!gateResults.build,
      },
      createdByCiPrincipal: guard.principal.id,
      idempotencyKey: String(body.idempotencyKey ?? ""),
    });
    return NextResponse.json(release, { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
