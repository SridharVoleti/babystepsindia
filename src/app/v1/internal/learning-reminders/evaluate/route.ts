import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { evaluateLearningReminders, type LearningReminderStage } from "@/lib/learning-reminders/service";
import { learningReminderRouteError, strictLearningReminderObject } from "@/lib/learning-reminders/route-utils";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "learning-reminder-scheduler");
  if (!guard.ok) return guard.response;
  try {
    const body = strictLearningReminderObject(await request.json(),
      ["reminderStage", "cursor", "limit", "runIdempotencyKey"]);
    if (!["mid_window", "final_window"].includes(String(body.reminderStage))
      || (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== "string")
      || typeof body.limit !== "number" || typeof body.runIdempotencyKey !== "string") {
      return NextResponse.json({ error: "LEARNING_REMINDER_REQUEST_INVALID" }, { status: 400 });
    }
    return NextResponse.json(evaluateLearningReminders({ reminderStage: body.reminderStage as LearningReminderStage,
      cursor: body.cursor as string | null | undefined, limit: body.limit as number,
      runIdempotencyKey: body.runIdempotencyKey as string, principalId: guard.principal.id }),
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return learningReminderRouteError(error); }
}
