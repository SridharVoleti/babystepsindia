import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { sendLearningReminder } from "@/lib/learning-reminders/service";
import { learningReminderRouteError, strictLearningReminderObject } from "@/lib/learning-reminders/route-utils";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "learning-reminder-sender");
  if (!guard.ok) return guard.response;
  try {
    const body = strictLearningReminderObject(await request.json(),
      ["parentReminderBatchId", "expectedBatchVersion", "idempotencyKey"]);
    if (typeof body.parentReminderBatchId !== "string" || typeof body.expectedBatchVersion !== "number"
      || typeof body.idempotencyKey !== "string") {
      return NextResponse.json({ error: "LEARNING_REMINDER_REQUEST_INVALID" }, { status: 400 });
    }
    return NextResponse.json(sendLearningReminder({ parentReminderBatchId: body.parentReminderBatchId,
      expectedBatchVersion: body.expectedBatchVersion, idempotencyKey: body.idempotencyKey }),
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return learningReminderRouteError(error); }
}
