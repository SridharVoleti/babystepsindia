import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { reconcileLearningReminderDeliveries } from "@/lib/learning-reminders/service";
import { learningReminderRouteError, strictLearningReminderObject } from "@/lib/learning-reminders/route-utils";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "learning-reminder-reconciliation");
  if (!guard.ok) return guard.response;
  try {
    const body = strictLearningReminderObject(await request.json(),
      ["batchId", "cursor", "limit", "runIdempotencyKey"]);
    if ((body.batchId !== undefined && body.batchId !== null && typeof body.batchId !== "string")
      || (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== "string")
      || typeof body.limit !== "number" || typeof body.runIdempotencyKey !== "string") {
      return NextResponse.json({ error: "LEARNING_REMINDER_REQUEST_INVALID" }, { status: 400 });
    }
    return NextResponse.json(reconcileLearningReminderDeliveries({ batchId: body.batchId as string | null | undefined,
      cursor: body.cursor as string | null | undefined, limit: body.limit,
      runIdempotencyKey: body.runIdempotencyKey, principalId: guard.principal.id }),
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return learningReminderRouteError(error); }
}
