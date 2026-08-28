import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { getPublishedDeployment } from "@/lib/deployment-production/service";
import { startLearnerSession } from "@/lib/learning-session/gateway";
import { lifecycleError } from "@/lib/session-finalization/route-utils";

// LP-004: the missing "create the learner session" route. `startLearnerSession`
// (src/lib/learning-session/gateway.ts) was fully built and tested but had no
// HTTP caller — every other /v1/learner-sessions/* route operates on a
// session id that must already exist. This is the entry point the learner
// launcher's "Start" action calls; the browser then POSTs the returned
// sessionId to /v1/learner-sessions/{id}/launch-dispatch.
//
// Schedule authorization (APP_ONBOARDING_AND_LAUNCH_GUIDE.md §11, option A):
// the always-live launcher has no pre-booking subsystem — `scheduleAuthorized`
// has no producer anywhere in the codebase. The learner's own eligibility to
// start *is* the authorization: startLearnerSession re-evaluates effective
// access, operational availability and funding inside its own transaction
// (that is the real gate), so this route passes `scheduleAuthorized: true`
// with a synthesized id and lets the gateway enforce.

const ENVIRONMENT = "production";
const FUNDING_SOURCES = ["normal", "standard_monthly", "technical_credit"] as const;
type FundingSource = (typeof FUNDING_SOURCES)[number];

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.session.start");
  if (!guard.ok) return guard.response;
  if (!guard.parent.session.sid) {
    return NextResponse.json({ error: "FRESH_LOGIN_REQUIRED" }, { status: 401 });
  }
  const learnerId = guard.authorization.learnerId;
  const deviceSessionId = guard.authorization.deviceSessionId;
  if (!learnerId) {
    return NextResponse.json({ error: "LEARNER_PROFILE_LOCKED" }, { status: 403 });
  }
  if (!checkRateLimit(`start-session:${guard.parent.session.sub}:${learnerId}`, 20, 60_000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const allowedKeys = ["appId", "idempotencyKey", "fundingSource", "creditId"];
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((key) => !allowedKeys.includes(key)) ||
      typeof body.appId !== "string" ||
      !body.appId.trim() ||
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey.trim()
    ) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const fundingSource =
      body.fundingSource === undefined ? undefined : (body.fundingSource as FundingSource);
    if (fundingSource !== undefined && !FUNDING_SOURCES.includes(fundingSource)) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const creditId = body.creditId;
    if (fundingSource === "technical_credit") {
      if (typeof creditId !== "string" || !creditId.trim()) {
        return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
    } else if (creditId !== undefined) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    const appId = body.appId.trim();
    const idempotencyKey = body.idempotencyKey.trim();
    const now = new Date();

    // Fail fast with a clean error before any funding/session work when the
    // app has no published production deployment. The gateway would also
    // reject a blocked/incompatible deployment; this just avoids reaching it
    // with nothing to resolve.
    const deployment = await getPublishedDeployment(appId, ENVIRONMENT, now);
    if (!deployment) {
      return NextResponse.json({ error: "APP_NOT_PUBLISHED" }, { status: 409 });
    }

    const result = await withLockedEndUserMutation({
      preflight: guard.authorization,
      action: "learner.session.start",
      resource: { learnerId },
      mutate: () =>
        startLearnerSession({
          actorSessionId: guard.parent.session.sid!,
          parentUserId: guard.parent.session.sub,
          selectedLearnerId: learnerId,
          learnerId,
          appId,
          deviceSessionId,
          scheduleAuthorizationId: `launcher:${learnerId}:${appId}`,
          scheduleAuthorized: true,
          idempotencyKey,
          now,
          fundingSource,
          creditId: fundingSource === "technical_credit" ? (creditId as string) : undefined,
          deployment,
        }),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return lifecycleError(error);
  }
}
