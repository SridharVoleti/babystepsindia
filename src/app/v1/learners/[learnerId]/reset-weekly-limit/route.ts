import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { LearnerCreationError, getOwnedLearner, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { resetWeeklyUsageForTesting } from "@/lib/session-credit-standard/service";

// Testing-only endpoint: lets a parent clear their own learner's weekly
// session counters so QA can retest weekly-limit flows without waiting for
// the ISO week to roll over. Not part of any frozen API contract.
export async function POST(
  request: Request,
  { params }: { params: { learnerId: string } },
) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    await getOwnedLearner(guard.parent.session.sub, params.learnerId, asOf);
    await withLockedEndUserMutation({
      preflight: guard.authorization,
      action: "parent.learner.manage",
      resource: { learnerId: params.learnerId },
      mutate: () => resetWeeklyUsageForTesting(params.learnerId, new Date()),
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const code = error instanceof LearnerCreationError ? error.code : "WEEKLY_LIMIT_RESET_FAILED";
    const status = code === "LEARNER_NOT_FOUND" ? 404 : code.startsWith("ACCOUNT_") ? 403 : 500;
    return NextResponse.json({ error: code }, { status });
  }
}
