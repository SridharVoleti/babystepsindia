export const LEARNING_REMINDER_API_CONTRACTS = {
  preferences: { id: "API-EG-024", method: "GET/PATCH", path: "/v1/parent/notification-preferences",
    authentication: "verified_parent_management", cache: "private_no_store" },
  evaluate: { id: "API-EG-025", method: "POST", path: "/v1/internal/learning-reminders/evaluate",
    authentication: "exact_learning_reminder_scheduler", idempotency: "stage_run_cursor" },
  send: { id: "API-EG-026", method: "POST", path: "/v1/internal/learning-reminders/send",
    authentication: "exact_learning_reminder_sender", idempotency: "batch_provider_key" },
  reconcile: { id: "API-EG-027", method: "POST", path: "/v1/internal/learning-reminders/reconcile-delivery",
    authentication: "exact_learning_reminder_reconciliation", idempotency: "provider_batch_run" },
} as const;
