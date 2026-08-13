import { NextResponse } from "next/server";
import { LearningReminderError } from "@/lib/learning-reminders/service";

export function strictLearningReminderObject(value: unknown, allowed: readonly string[]) {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new LearningReminderError("LEARNING_REMINDER_REQUEST_INVALID");
  }
  return value as Record<string, unknown>;
}

export function learningReminderRouteError(error: unknown) {
  const code = error instanceof LearningReminderError ? error.code : "LEARNING_REMINDER_OPERATION_FAILED";
  const status = code === "LEARNING_REMINDER_BATCH_NOT_FOUND" ? 404
    : code.includes("CONFLICT") || code === "LEARNING_REMINDER_RUN_IN_PROGRESS" ? 409 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}
