import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { learningReminderRouteError, strictLearningReminderObject } from "@/lib/learning-reminders/route-utils";
import { composeParentNotificationPreferences, applyParentNotificationPreferenceChange } from "@/lib/notification-preferences/service";

// API-NT-008/API-NT-009 (amends API-EG-024 — one durable preference
// authority, not two, rules 5/88-89): the frozen NotificationPreferences
// contract layered over EG-006's existing parent_notification_preferences
// row and NT-001's mandatory-category policy. Concurrency (expectedVersion)
// and idempotency-key handling are unchanged, owned entirely by
// updateParentNotificationPreference.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.notification_preferences.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json(composeParentNotificationPreferences(guard.parent.session.sub),
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
    const result = await withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.notification_preferences.update", resource: { parentUserId: guard.parent.session.sub },
      mutate: () => applyParentNotificationPreferenceChange(guard.parent.session.sub, {
        learningReminderEmailEnabled: body.learningReminderEmailEnabled as boolean,
        expectedVersion: body.expectedVersion as number, idempotencyKey: body.idempotencyKey as string,
      }) });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return learningReminderRouteError(error); }
}
