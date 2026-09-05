import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AdminLearnerSessionLimitError, setLearnerSessionLimitOverride } from "@/lib/db/learner-repo";

function domainError(error: unknown) {
  const code = error instanceof AdminLearnerSessionLimitError ? error.code : "SESSION_LIMIT_UPDATE_FAILED";
  const status = code === "LEARNER_NOT_FOUND" ? 404
    : code === "LEARNER_VERSION_CONFLICT" ? 409
    : code === "SESSION_LIMIT_OVERRIDE_INVALID" ? 400
    : 500;
  return NextResponse.json({ error: code }, { status });
}

export async function PATCH(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireAdminApi("admin.learner.session_limit.update");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`admin-learner-session-limit:${guard.session.sub}`, 30, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const { unlimitedSessions, weeklySessionLimitOverride, expectedVersion } = body;
  if (
    typeof unlimitedSessions !== "boolean" ||
    !(weeklySessionLimitOverride === null || (typeof weeklySessionLimitOverride === "number" && Number.isInteger(weeklySessionLimitOverride))) ||
    typeof expectedVersion !== "number"
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  try {
    const learner = await setLearnerSessionLimitOverride(params.learnerId, {
      unlimitedSessions, weeklySessionLimitOverride, expectedVersion,
    });
    return NextResponse.json({ learner }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return domainError(error);
  }
}
