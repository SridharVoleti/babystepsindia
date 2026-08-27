import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { getPublishedDeployment } from "@/lib/deployment-production/service";

// AC24/29: the only trusted read of "what's currently live for new
// learner sessions" — resolves strictly through the atomic publication
// pointer (see getPublishedDeployment's own doc comment for the
// learning-session/gateway.ts integration gap this session leaves open).
export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireInternalService(request, "ci-deployer");
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const environment = searchParams.get("environment") ?? "production";
  const deployment = await getPublishedDeployment(params.appId, environment);
  if (!deployment) return NextResponse.json({ error: "DEPLOYMENT_NOT_FOUND" }, { status: 404 });
  return NextResponse.json(deployment);
}
