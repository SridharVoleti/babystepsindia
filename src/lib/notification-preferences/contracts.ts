// NT-003: the one canonical parent communication-preference policy and
// response contract. No new preference table (rules 86-89) — this module
// is a read-only presentation/composition layer over EG-006's existing
// `parent_notification_preferences` row (the sole durable preference
// authority) and NT-001's version-controlled type registry (the sole
// mandatory/category policy authority). NT-003 owns presentation and
// validation only (rule 5), never a second source of truth.

export type NotificationPreferenceCategoryKey =
  | "billing" | "financial_document" | "account_security" | "service" | "learning_reminders";

export type NotificationPreferenceCategory = {
  key: NotificationPreferenceCategoryKey;
  label: string;
  required: boolean;
  channel: "email";
  status: string;
  description: string;
  preferenceKey?: "learningReminderEmailEnabled";
  enabled?: boolean;
};

export type NotificationPreferences = {
  preferenceVersion: number;
  updatedAt: string;
  destination: { channel: "email"; verifiedEmailHint?: string };
  categories: NotificationPreferenceCategory[];
  communicationHistoryRoute: string;
};
