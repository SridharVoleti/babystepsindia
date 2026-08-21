import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { getOwnedLearner, getParentTimezone } from "@/lib/learner-profile/production-gateway";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";

export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try { const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    const learner = await getOwnedLearner(guard.parent.session.sub, params.learnerId, asOf);
    return NextResponse.json({ id: learner.id, displayName: learner.displayName, ageYears: learner.ageYears,
      ageMonths: learner.ageMonths, ageAsOfDate: learner.ageAsOfDate, avatarId: learner.avatarId,
      locale: learner.locale, timezone: learner.timezone }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { const code = error && typeof error === "object" && "code" in error ? String(error.code) : "LEARNER_CONTEXT_FAILED";
    return NextResponse.json({ error: code }, { status: code === "LEARNER_NOT_FOUND" ? 404 : 400 }); }
}
