import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import {
  LearnerCreationError,
  getOwnedLearner,
  getParentTimezone,
  updateLearner,
} from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { LearnerValidationError } from "@/lib/learner-profile/validation";
import { validateLearnerUpdateBody } from "@/lib/learner-profile/update-validation";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

function responseLearner(learner: Awaited<ReturnType<typeof getOwnedLearner>>) {
  const { ownerParentId: _ownerParentId, locale: _locale, timezone: _timezone, ...safe } = learner;
  return safe;
}

function domainError(error: unknown) {
  const code = error instanceof LearnerCreationError || error instanceof LearnerValidationError
    ? error.code
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
  if (!checkRateLimit(`learner-update:${guard.parent.session.sub}:${params.learnerId}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const validation = validateLearnerUpdateBody(body);
  if (!validation.ok) return NextResponse.json({ error: validation.code }, { status: 400 });
  try {
    const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    const result = await withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.learner.manage", resource: { learnerId: params.learnerId },
      mutate: () => updateLearner(guard.parent.session.sub, params.learnerId, validation.value, asOf) });
    return NextResponse.json({ ...result, learner: responseLearner(result.learner) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return domainError(error);
  }
}
