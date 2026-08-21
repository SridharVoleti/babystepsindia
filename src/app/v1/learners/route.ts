import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { createOwnedLearner, getParentTimezone, listOwnedLearners } from "@/lib/learner-profile/production-gateway";
import { validateLearnerCreateBody } from "@/lib/learner-profile/create-validation";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";

// Postgres service transactions replace the legacy withLockedEndUserMutation SQLite boundary.

const safe = (learner: Record<string, unknown>) => { const { ownerParentId: _owner, locale: _locale, timezone: _timezone, ...result } = learner; return result; };
const failure = (error: unknown) => { const code = error && typeof error === "object" && "code" in error ? String(error.code) : "LEARNER_CREATION_FAILED";
  const status = ["IDEMPOTENCY_KEY_REUSED", "LEARNER_NAME_ALREADY_EXISTS"].includes(code) ? 409 : code.startsWith("ACCOUNT_") ? 403 : code === "LEARNER_CREATION_FAILED" ? 500 : 400;
  return NextResponse.json({ error: code }, { status }); };

export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.learners.list"); if (!guard.ok) return guard.response;
  try { const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    return NextResponse.json({ learners: (await listOwnedLearners(guard.parent.session.sub, asOf)).map(item => safe(item as unknown as Record<string, unknown>)) },
      { headers: { "Cache-Control": "private, no-store" } }); } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.manage"); if (!guard.ok) return guard.response;
  if (!(await consumeDistributedRateLimit({ key: `learner-create:${guard.parent.session.sub}`, limit: 10, windowMs: 60 * 60 * 1000 })))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  let body: unknown; try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const validation = validateLearnerCreateBody(body); if (!validation.ok) return NextResponse.json({ error: validation.code }, { status: 400 });
  try { const asOf = calendarDateInTimeZone(await getParentTimezone(guard.parent.session.sub));
    const result = await createOwnedLearner(guard.parent.session.sub, validation.value, asOf);
    return NextResponse.json({ learner: safe(result.learner as unknown as Record<string, unknown>), onboardingStatus: result.onboardingStatus },
      { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "private, no-store" } }); } catch (error) { return failure(error); }
}
