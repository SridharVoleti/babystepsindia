import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { LEAD_TIME_MS, listWindows, scheduleDeploymentWindow } from "@/lib/deployment-window/service";

// AR-002 session 2, business rules 50-51: a pre-scheduled app-specific
// production window, at least 60 minutes ahead. Same
// app_deployment_promote permission family as approve-production, since
// scheduling one is what makes a later promotion possible at all.
export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.deployment.windows.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ windows: await listWindows(params.appId), leadTimeMinutes: LEAD_TIME_MS / 60000 });
}

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.deployment.windows.schedule");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`deployment-window-schedule:${guard.session.sub}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const reauthFailure = await requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : null;
  const endsAt = typeof body.endsAt === "string" ? new Date(body.endsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime()) || !endsAt || Number.isNaN(endsAt.getTime())) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const window = await scheduleDeploymentWindow(
      {
        appId: params.appId,
        releaseId: String(body.releaseId ?? ""),
        startsAt,
        endsAt,
        adminUserId: guard.session.sub,
        idempotencyKey: String(body.idempotencyKey ?? ""),
      },
      new Date(),
    );
    return NextResponse.json(window, { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
