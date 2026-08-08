import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { purgeDeploymentArtifacts } from "@/lib/deployment-retention/service";

// AR-002 session 2, business rules 40-41: scheduled purge of superseded/
// failed/rolled-back deployments, completed windows, processed webhook
// receipts, and completed operation requests past their retention window.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "deployment-scheduler");
  if (!guard.ok) return guard.response;
  const result = purgeDeploymentArtifacts(new Date());
  return NextResponse.json(result);
}
