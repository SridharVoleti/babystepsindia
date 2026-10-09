import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { resolveProviderRecordingFailure } from "@/lib/deployment-provider/config-failure";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { sweepReleaseSafetyObservations } from "@/lib/deployment-rollback/service";

// AR-002 session 2, business rules 32-33: the scheduled entry point for the
// ten-minute/one-check-per-minute post-publish release-safety observation.
// Intended to be invoked on a short recurring cadence (see
// scripts/run-ar002-deployment-sweeps.mjs) — a no-op call when nothing is
// currently 'observing' is cheap, so over-frequent invocation is safe.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "deployment-scheduler");
  if (!guard.ok) return guard.response;
  let provider;
  try {
    provider = await resolveProviderRecordingFailure({ operation: "safety_sweep" });
  } catch (error) {
    if (error instanceof DeploymentPipelineError) return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    throw error;
  }
  await sweepReleaseSafetyObservations(new Date(), provider);
  return NextResponse.json({ ok: true });
}
