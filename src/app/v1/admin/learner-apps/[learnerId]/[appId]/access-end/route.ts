import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AdminLearnerAppError, setLearnerAppAccessEnd } from "@/lib/db/learner-app-admin-repo";

function domainError(error: unknown) {
  const code = error instanceof AdminLearnerAppError ? error.code : "ACCESS_END_UPDATE_FAILED";
  const status = code === "LEARNER_APP_NOT_FOUND" || code === "NO_ENTITLEMENT_PERIOD" ? 404
    : code === "ACCESS_END_INVALID" || code === "ACCESS_END_BEFORE_PERIOD_START" ? 400
    : 500;
  return NextResponse.json({ error: code }, { status });
}

export async function PATCH(request: Request, { params }: { params: { learnerId: string; appId: string } }) {
  const guard = await requireAdminApi("admin.learner_app.access_end.update");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`admin-learner-app-access-end:${guard.session.sub}`, 30, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.accessEnd !== "string") return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });

  try {
    const result = await setLearnerAppAccessEnd(params.learnerId, params.appId, { accessEnd: body.accessEnd });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return domainError(error);
  }
}
