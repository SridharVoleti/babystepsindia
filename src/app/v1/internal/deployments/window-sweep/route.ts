import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { resolveProviderRecordingFailure } from "@/lib/deployment-provider/config-failure";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { sweepDeploymentWindows } from "@/lib/deployment-window/service";

// AR-002 session 2, business rules 55, 58: the scheduled entry point that
// confirms zero reserved sessions at a window's starts_at, executes the
// promotion, and keeps overrun windows fail-closed.
//
// Executes production promotion, whose provider promote() polls to READY.
export const maxDuration = 60;

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "deployment-scheduler");
  if (!guard.ok) return guard.response;
  let provider;
  try {
    provider = await resolveProviderRecordingFailure({ operation: "window_sweep" });
  } catch (error) {
    if (error instanceof DeploymentPipelineError) return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    throw error;
  }
  await sweepDeploymentWindows(new Date(), provider);
  return NextResponse.json({ ok: true });
}
