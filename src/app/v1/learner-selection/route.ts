import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { getLearnerSelection, LearnerSessionError, selectLearner } from "@/lib/learning-session/gateway";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { generateUiCapabilityHints } from "@/lib/authorization/ui-capabilities";

function sessionScope(session: { sid?: string; exp?: number }) {
  if (!session.sid || !session.exp) throw new LearnerSessionError("FRESH_LOGIN_REQUIRED");
  return { sid: session.sid, expiresAt: new Date(session.exp * 1000).toISOString() };
}

function errorResponse(error: unknown) {
  const code = error instanceof LearnerSessionError ? error.code : "SELECTION_FAILED";
  const status = code === "LEARNER_NOT_FOUND" ? 404 : code === "FRESH_LOGIN_REQUIRED" ? 401 : 400;
  return NextResponse.json({ error: code }, { status });
}

export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request,"parent.learners.list");
  if (!guard.ok) return guard.response;
  try {
    const scope = sessionScope(guard.parent.session);
    const selection = getLearnerSelection(scope.sid, guard.parent.session.sub, scope.expiresAt);
    return NextResponse.json({ ...selection, capabilities: generateUiCapabilityHints({ principal: guard.principal,
      candidateActions: ["parent.learners.list", "parent.learner.select", "parent.learner.manage"],
      resource: { parentUserId: guard.parent.session.sub } }) },
    { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  const guard = await requireEndUserAuthorization(request,"parent.learner.select");
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "learnerId") ||
    typeof (body as { learnerId?: unknown }).learnerId !== "string") {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  try {
    const scope = sessionScope(guard.parent.session);
    const learnerId = (body as { learnerId: string }).learnerId;
    return NextResponse.json(await withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.learner.select", resource: { learnerId },
      mutate: () => selectLearner(scope.sid, guard.parent.session.sub, learnerId, scope.expiresAt) }),
    { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
