// NT-001: version-controlled notification type registry. This is a code/
// release artifact, not parent- or admin-authored database content (rules
// 20-21, 90) — a new type requires a new deployed version of this file, the
// same discipline already used for progress-schema-registry/app-progress
// schema contracts elsewhere in this codebase.
//
// V1 scope: 9 types have a real source call site wired this session
// (billing_renewal_reminder through account_password_changed below).
// invoice_receipt_available and approved_service_notice are declared and
// template-rendered but have no real producer yet — BI-005 has no invoice/
// receipt document generation in this codebase, and UL-004 has no "this
// warrants an email" decision point. Both are exercised only by
// fixture-constructed tests, matching this codebase's established
// EN-004 precedent for real-but-currently-unreachable paths.
export type NotificationCategory = "billing" | "financial_document" | "account_security" | "service";
export type SafeVariableType = "string" | "number" | "boolean";
export type SafeVariableSchema = Record<string, SafeVariableType>;

export type NotificationTypeDefinition = {
  key: string;
  category: NotificationCategory;
  allowedSourceDomain: string;
  // Rule 129/131: every V1 type is mandatory. No type in V1 reads
  // learningReminderEmailEnabled or any other suppression preference
  // (rule 41-44) — mandatory is a fixed property of the type, not a
  // runtime/source-supplied flag (rule 130).
  mandatory: true;
  // Forward-declared for NT-002's future history projection; unused by
  // NT-001 itself this session (rule 121).
  historyVisible: boolean;
  templateVersion: string;
  requiredVariables: SafeVariableSchema;
  optionalVariables: SafeVariableSchema;
};

export const NOTIFICATION_TYPE_REGISTRY: Record<string, NotificationTypeDefinition> = {
  billing_renewal_reminder: {
    key: "billing_renewal_reminder", category: "billing", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string", renewalDate: "string", amount: "number", currency: "string" },
    optionalVariables: { learnerName: "string" },
  },
  billing_grace_started: {
    key: "billing_grace_started", category: "billing", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string", graceEndsAt: "string" },
    optionalVariables: {},
  },
  billing_payment_recovered: {
    key: "billing_payment_recovered", category: "billing", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string" },
    optionalVariables: {},
  },
  billing_grace_expired: {
    key: "billing_grace_expired", category: "billing", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string" },
    optionalVariables: {},
  },
  subscription_cancellation_scheduled: {
    key: "subscription_cancellation_scheduled", category: "billing", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string", accessEndsAt: "string" },
    optionalVariables: {},
  },
  subscription_cancellation_reversed: {
    key: "subscription_cancellation_reversed", category: "billing", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string" },
    optionalVariables: {},
  },
  billing_refund_outcome: {
    key: "billing_refund_outcome", category: "financial_document", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { subscriptionLabel: "string", refundType: "string" },
    optionalVariables: { amount: "number" },
  },
  account_email_changed: {
    key: "account_email_changed", category: "account_security", allowedSourceDomain: "identity",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: {},
    optionalVariables: {},
  },
  account_password_changed: {
    key: "account_password_changed", category: "account_security", allowedSourceDomain: "identity",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: {},
    optionalVariables: {},
  },
  invoice_receipt_available: {
    key: "invoice_receipt_available", category: "financial_document", allowedSourceDomain: "billing",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { documentLabel: "string" },
    optionalVariables: {},
  },
  approved_service_notice: {
    key: "approved_service_notice", category: "service", allowedSourceDomain: "operations",
    mandatory: true, historyVisible: true, templateVersion: "v1",
    requiredVariables: { noticeTitle: "string" },
    optionalVariables: {},
  },
};

export function getNotificationTypeDefinition(notificationType: string): NotificationTypeDefinition | undefined {
  return NOTIFICATION_TYPE_REGISTRY[notificationType];
}

// Rules 23-24: unknown types, unknown template versions and unexpected
// variables are all rejected before anything is persisted; required
// variables must be present and correctly typed.
export function validateSafeVariables(
  definition: NotificationTypeDefinition,
  safeVariables: Record<string, unknown>,
): string | null {
  const allowedKeys = new Set([
    ...Object.keys(definition.requiredVariables),
    ...Object.keys(definition.optionalVariables),
  ]);
  for (const key of Object.keys(safeVariables)) {
    if (!allowedKeys.has(key)) return `UNKNOWN_VARIABLE:${key}`;
  }
  const schema = { ...definition.requiredVariables, ...definition.optionalVariables };
  for (const [key, type] of Object.entries(definition.requiredVariables)) {
    if (!(key in safeVariables)) return `MISSING_VARIABLE:${key}`;
    void type;
  }
  for (const [key, value] of Object.entries(safeVariables)) {
    const expectedType = schema[key];
    if (expectedType === "string" && (typeof value !== "string" || value.length === 0 || value.length > 500)) {
      return `INVALID_VARIABLE:${key}`;
    }
    if (expectedType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      return `INVALID_VARIABLE:${key}`;
    }
    if (expectedType === "boolean" && typeof value !== "boolean") {
      return `INVALID_VARIABLE:${key}`;
    }
  }
  return null;
}
