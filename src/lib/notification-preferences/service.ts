import { getParentNotificationPreference, updateParentNotificationPreference } from "@/lib/learning-reminders/service";
import { resolveCurrentVerifiedParentEmail } from "@/lib/notifications/recipient";
import { maskEmail } from "@/lib/account/mask";
import { NOTIFICATION_TYPE_REGISTRY, type NotificationCategory } from "@/lib/notifications/contracts";
import type { NotificationPreferenceCategory, NotificationPreferences } from "./contracts";

export const COMMUNICATION_HISTORY_ROUTE = "/account/notifications/history";

// Rules 11-16: the four mandatory display categories, one per distinct
// NT-001 registry category. Every registry entry's `mandatory` field is
// `true` at the TypeScript-literal level (contracts.ts), so "always on" is
// a structural invariant here, not a runtime flag this module re-derives
// per type — deriving per-category (not per-type) keeps this in sync
// automatically as NT-001 types are added, with no NT-003 edit required.
const MANDATORY_CATEGORY_META: Record<NotificationCategory, { label: string; description: string }> = {
  billing: { label: "Billing & payments", description: "Payment, renewal and subscription emails you need to manage your plan." },
  financial_document: { label: "Financial documents & refunds", description: "Invoices, receipts and refund confirmations." },
  account_security: { label: "Account & security", description: "Changes to your email, password or account security." },
  service: { label: "Material service notices", description: "Important service or maintenance notices that affect your account." },
};
const MANDATORY_CATEGORY_ORDER: NotificationCategory[] = ["billing", "financial_document", "account_security", "service"];

function mandatoryCategories(): NotificationPreferenceCategory[] {
  const present = new Set(Object.values(NOTIFICATION_TYPE_REGISTRY).map((definition) => definition.category));
  return MANDATORY_CATEGORY_ORDER.filter((category) => present.has(category)).map((category) => ({
    key: category, label: MANDATORY_CATEGORY_META[category].label, required: true, channel: "email" as const,
    // Rule 23/94-95: text status, never a disabled-look toggle — a disabled
    // control implies the parent could enable it elsewhere, which is false.
    status: "Always on", description: MANDATORY_CATEGORY_META[category].description,
  }));
}

// Rules 17-18/93: the one V1 optional category — the same shared EG-006
// field, never a duplicate.
function learningReminderCategory(enabled: boolean): NotificationPreferenceCategory {
  return {
    key: "learning_reminders", label: "Learning reminders", required: false, channel: "email",
    status: enabled ? "On" : "Off",
    description: "Weekly reminders about upcoming learning sessions for your learners.",
    preferenceKey: "learningReminderEmailEnabled", enabled,
  };
}

// Rules 63-64: current verified email only, masked — never a pending
// unverified replacement (resolveCurrentVerifiedParentEmail structurally
// never reads email_change_requests, so this is safe by construction).
function destination(parentId: string): NotificationPreferences["destination"] {
  const verified = resolveCurrentVerifiedParentEmail(parentId);
  return { channel: "email", verifiedEmailHint: verified ? maskEmail(verified.email) : undefined };
}

// API-NT-008: GET /v1/parent/notification-preferences. Pure read, no
// provider call (rule 132).
export function composeParentNotificationPreferences(parentId: string, now = new Date()): NotificationPreferences {
  const preference = getParentNotificationPreference(parentId, now);
  return {
    preferenceVersion: preference.version,
    updatedAt: preference.updatedAt,
    destination: destination(parentId),
    categories: [...mandatoryCategories(), learningReminderCategory(preference.learningReminderEmailEnabled)],
    communicationHistoryRoute: COMMUNICATION_HISTORY_ROUTE,
  };
}

export type ApplyParentNotificationPreferenceChangeInput = {
  learningReminderEmailEnabled: boolean;
  expectedVersion: number;
  idempotencyKey: string;
};

// API-NT-009: PATCH /v1/parent/notification-preferences. Only the one
// allowlisted optional key is writable (rules 21-22, enforced upstream by
// strictLearningReminderObject at the route boundary, unchanged) — this
// function accepts no mandatory-category field at all, so there is no
// mandatory value to tamper with here even in principle. Delegates the
// actual write, expectedVersion/idempotencyKey enforcement to EG-006's
// existing updateParentNotificationPreference (rules 80-83) — NT-003 never
// re-implements concurrency/idempotency, only re-presents the result.
export function applyParentNotificationPreferenceChange(
  parentId: string, input: ApplyParentNotificationPreferenceChangeInput, now = new Date(),
): NotificationPreferences {
  updateParentNotificationPreference(parentId, { ...input, now });
  return composeParentNotificationPreferences(parentId, now);
}
