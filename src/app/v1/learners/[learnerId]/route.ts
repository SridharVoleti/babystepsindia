import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import {
  getOwnedLearner,
  getParentTimezone,
  updateOwnedLearner,
} from "@/lib/learner-profile/production-gateway";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { LearnerValidationError } from "@/lib/learner-profile/validation";
import { protectedFieldCategory, validateLearnerUpdateBody } from "@/lib/learner-profile/update-validation";
import { auditRejectedLearnerProfileMutation } from "@/lib/learner-profile/rejection-audit";

function responseLearner(learner: Record<string, unknown>) {
  const { ownerParentId: _ownerParentId, locale: _locale, timezone: _timezone, ...safe } = learner;
  return safe;
}

function domainError(error: unknown) {
  const code = error instanceof LearnerValidationError ? error.code
    : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
    : "LEARNER_UPDATE_FAILED";
  const status = code === "LEARNER_NOT_FOUND" ? 404
    : ["LEARNER_NAME_ALREADY_EXISTS", "LEARNER_VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED"].includes(code) ? 409
    : code.startsWith("ACCOUNT_") ? 403
    : code === "LEARNER_UPDATE_FAILED" ? 500
    : 400;
  return NextResponse.json({ error: code }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: { learnerId: string } },
) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    return NextResponse.json(responseLearner(await getOwnedLearner(
      guard.parent.session.sub, params.learnerId, asOf,
    )), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return domainError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { learnerId: string } },
) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  if (!await consumeDistributedRateLimit({ key: `learner-update:${guard.parent.session.sub}:${params.learnerId}`, limit: 30, windowMs: 60 * 60 * 1000 })) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const validation = validateLearnerUpdateBody(body);
  if (!validation.ok) {
    if (validation.code === "FORBIDDEN_FIELD") {
      try {
        await auditRejectedLearnerProfileMutation({ parentUserId: guard.parent.session.sub,
          learnerId: params.learnerId, protectedFieldCategory: protectedFieldCategory(body) });
      } catch { /* A failed audit sink must never permit the rejected mutation. */ }
    }
    return NextResponse.json({ error: validation.code }, { status: 400 });
  }
  try {
    const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    // Postgres transactions replace the legacy withLockedEndUserMutation SQLite boundary.
    const result = await updateOwnedLearner(guard.parent.session.sub, params.learnerId, validation.value, asOf);
    return NextResponse.json({ ...result, learner: responseLearner(result.learner) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return domainError(error);
  }
}
