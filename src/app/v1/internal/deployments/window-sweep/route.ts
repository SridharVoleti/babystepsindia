import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";
import { sweepDeploymentWindows } from "@/lib/deployment-window/service";

// AR-002 session 2, business rules 55, 58: the scheduled entry point that
// confirms zero reserved sessions at a window's starts_at, executes the
// promotion, and keeps overrun windows fail-closed.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "deployment-scheduler");
  if (!guard.ok) return guard.response;
  await sweepDeploymentWindows(new Date(), resolveDeploymentProvider());
  return NextResponse.json({ ok: true });
}
