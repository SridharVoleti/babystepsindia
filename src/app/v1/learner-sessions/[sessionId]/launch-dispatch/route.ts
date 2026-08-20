import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { parseDispatchBody } from "@/lib/app-launch/contracts";
import { resolveTrustedDeployment } from "@/lib/app-launch/deployment";
import { AppLaunchError, dispatchAppLaunch } from "@/lib/app-launch/service";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

function failure(error: unknown) {
  const code = error instanceof AppLaunchError ? error.code : "LAUNCH_DISPATCH_FAILED";
  const status = code === "SESSION_NOT_FOUND" ? 404 : code === "SESSION_VERSION_CONFLICT" ? 409 :
    code === "APP_DEPLOYMENT_WINDOW_BLOCKED" ? 503 : code === "INVALID_REQUEST" ||
    code === "DESTINATION_OVERRIDE_REJECTED" ? 400 : 403;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const guard = await requireEndUserAuthorization(request,"learner.session.start");
  if (!guard.ok) return guard.response;
  if (!guard.parent.session.sid) return NextResponse.json({ error: "FRESH_LOGIN_REQUIRED" }, { status: 401 });
  const actorSessionId = guard.parent.session.sid;
  const learnerId = guard.authorization.learnerId;
  const deviceSessionId = guard.authorization.deviceSessionId;
  if (!learnerId) return NextResponse.json({ error: "LEARNER_PROFILE_LOCKED" }, { status: 403 });
  if (!checkRateLimit(`launch-dispatch:${guard.parent.session.sub}:${params.sessionId}`, 20, 60_000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const body = parseDispatchBody(await request.json());
    const result = await withLockedEndUserMutation({ preflight: guard.authorization, action: "learner.session.start",
      resource: { learnerId }, mutate: () => dispatchAppLaunch({ sessionId: params.sessionId, learnerId, actorSessionId,
      deviceSessionId, expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey,
      now: new Date(), deployment: resolveTrustedDeployment(params.sessionId, new Date()) }) });
    return new NextResponse(result.html, { status: 200, headers: { ...result.headers,
      "Content-Type": "text/html; charset=utf-8" } });
  } catch (error) { return failure(error); }
}
