import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { cancelDeploymentWindow } from "@/lib/deployment-window/service";

export async function POST(request: Request, { params }: { params: { appId: string; windowId: string } }) {
  const guard = await requireAdminApi("admin.deployment.windows.cancel");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`deployment-window-cancel:${guard.session.sub}`, 10, 5 * 60 * 1000)) {
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

  try {
    const window = cancelDeploymentWindow(
      {
        windowId: params.windowId,
        expectedVersion: Number(body.expectedVersion),
        adminUserId: guard.session.sub,
        idempotencyKey: String(body.idempotencyKey ?? ""),
      },
      new Date(),
    );
    return NextResponse.json(window);
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
