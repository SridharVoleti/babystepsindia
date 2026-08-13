import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { getParentNotificationPreference, updateParentNotificationPreference } from "@/lib/learning-reminders/service";
import { learningReminderRouteError, strictLearningReminderObject } from "@/lib/learning-reminders/route-utils";

export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.notification_preferences.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json(getParentNotificationPreference(guard.parent.session.sub),
    { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.notification_preferences.update");
  if (!guard.ok) return guard.response;
  try {
    const body = strictLearningReminderObject(await request.json(),
      ["learningReminderEmailEnabled", "expectedVersion", "idempotencyKey"]);
    if (typeof body.learningReminderEmailEnabled !== "boolean" || typeof body.expectedVersion !== "number"
      || typeof body.idempotencyKey !== "string") {
      return NextResponse.json({ error: "LEARNING_REMINDER_REQUEST_INVALID" }, { status: 400,
        headers: { "Cache-Control": "no-store" } });
    }
    const result = withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.notification_preferences.update", resource: { parentUserId: guard.parent.session.sub },
      mutate: () => updateParentNotificationPreference(guard.parent.session.sub, {
        learningReminderEmailEnabled: body.learningReminderEmailEnabled as boolean,
        expectedVersion: body.expectedVersion as number, idempotencyKey: body.idempotencyKey as string,
      }) });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return learningReminderRouteError(error); }
}
