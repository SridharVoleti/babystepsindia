import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { evaluateAccessFresh, EntitlementAccessError } from "@/lib/entitlement-access/service";

const STATUS_BY_CODE: Record<string, number> = {
  RESOURCE_NOT_FOUND: 404,
};

const USE_CASES = new Set(["launcher", "start", "launch_exchange", "usable_launch", "resume"]);

// EN-002, trusted-platform-service-only. The three in-process gates (Start,
// LA-001 exchange, SC-003 usable launch) call evaluateAccessFresh directly,
// not this route — this exists for external/admin/future-billing callers,
// matching the existing "prefer an in-process call where the caller already
// runs server-side" convention.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-evaluator");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const { learnerId, appId, environment, useCase } = body;
  if (typeof learnerId !== "string" || typeof appId !== "string" || typeof environment !== "string" ||
      typeof useCase !== "string" || !USE_CASES.has(useCase)) {
    return NextResponse.json({ error: "INVALID_ENTITLEMENT_CONTEXT" }, { status: 400 });
  }

  try {
    const decision = await evaluateAccessFresh({
      learnerId, appId, environment, useCase: useCase as "launcher" | "start" | "launch_exchange" | "usable_launch" | "resume",
      now: new Date(),
    });
    return NextResponse.json(decision);
  } catch (error) {
    if (error instanceof EntitlementAccessError) {
      return NextResponse.json({ error: error.code }, { status: STATUS_BY_CODE[error.code] ?? 400 });
    }
    throw error;
  }
}
