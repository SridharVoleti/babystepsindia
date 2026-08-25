import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { LearnerCreationError, createLearner, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { LearnerValidationError } from "@/lib/learner-profile/validation";
import { validateLearnerCreateBody } from "@/lib/learner-profile/create-validation";

function responseLearner(learner: { ownerParentId: string; locale: string; timezone: string; [key: string]: unknown }) {
  const { ownerParentId: _ownerParentId, locale: _locale, timezone: _timezone, ...safe } = learner;
  return safe;
}

function domainError(error: unknown) {
  const code = error instanceof LearnerCreationError || error instanceof LearnerValidationError
    ? error.code
    : "LEARNER_CREATION_FAILED";
  const status = ["LEARNER_NAME_ALREADY_EXISTS", "IDEMPOTENCY_KEY_REUSED", "LEARNER_CREATION_IN_PROGRESS"].includes(code) ? 409
    : code.startsWith("ACCOUNT_") || code === "PARENT_PROFILE_NOT_FOUND" ? 403
    : code === "LEARNER_CREATION_FAILED" ? 500
    : 400;
  return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`learner-create:${guard.parent.session.sub}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const validation = validateLearnerCreateBody(body);
  if (!validation.ok) return NextResponse.json({ error: validation.code }, { status: 400 });
  try {
    const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    const result = await createLearner(guard.parent.session.sub, validation.value, asOf);
    return NextResponse.json({ ...result, learner: responseLearner(result.learner) }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return domainError(error);
  }
}
