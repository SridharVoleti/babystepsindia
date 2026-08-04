import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { AnalyticsError } from "@/lib/analytics/errors";
import { validateContributionPayload } from "@/lib/analytics/validation";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";

const STATUS_BY_CODE: Record<string, number> = {
  CONTRIBUTION_PAYLOAD_INVALID: 400,
  CONTRIBUTION_PAYLOAD_UNKNOWN_FIELD: 400,
  ANALYTICS_SECRET_MISSING: 500,
  APP_NOT_FOUND: 404,
  APP_NOT_ACTIVE: 409,
};

// Trusted-platform-service-only. Never called from a browser (AC31) — see
// requireInternalService. Prefer an in-process service call/outbox over
// this HTTP endpoint where the caller already runs server-side; this
// route exists for callers outside the Next.js process (a learning app
// backend, the scheduler, etc).
export async function POST(request: Request) {
  const guard = requireInternalService(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  try {
    const payload = validateContributionPayload(body);
    const result = applyDailyContribution(payload);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AnalyticsError) {
      return NextResponse.json({ error: error.code }, { status: STATUS_BY_CODE[error.code] ?? 400 });
    }
    throw error;
  }
}
