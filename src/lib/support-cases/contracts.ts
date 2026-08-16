export class SupportCaseError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "SupportCaseError"; }
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REASON: 400, INVALID_NOTE_TEXT: 400, INVALID_ESCALATION_ROLE: 400,
  RECEIPT_NOT_FOUND: 404, CASE_NOT_FOUND: 404, ASSIGNEE_NOT_FOUND: 404,
  RECEIPT_NOT_MATCHED: 409, RECEIPT_EXPIRED: 409, VERSION_CONFLICT: 409, CASE_CLOSED: 409,
  INVALID_TRANSITION: 409, CASE_NOT_REOPENABLE: 409, CASE_RETENTION_EXPIRED: 409, IDEMPOTENCY_KEY_REUSED: 409,
  NOTE_CONTAINS_FORBIDDEN_CONTENT: 422,
};
export function supportCaseErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 422;
}

export const SUPPORT_CASE_CATEGORIES = [
  "account_access", "learner_access", "billing_question", "subscription_assignment", "payment_refund",
  "app_access", "progress_display", "technical_issue", "notification_delivery", "other",
] as const;
export type SupportCaseCategory = (typeof SUPPORT_CASE_CATEGORIES)[number];

export const SUPPORT_CASE_STATUSES = [
  "open", "in_progress", "waiting_parent", "escalated", "resolved", "closed",
] as const;
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number];

export const SUPPORT_CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type SupportCasePriority = (typeof SUPPORT_CASE_PRIORITIES)[number];

// Rule 64: the escalation target role family — never a fourth
// support_agent-facing option (escalating support-to-support is meaningless).
export const ESCALATION_ROLES = ["billing_administrator", "operations_administrator", "platform_administrator"] as const;
export type EscalationRole = (typeof ESCALATION_ROLES)[number];

// Rule 18: the only four supported exact lookup identifier types.
export const LOOKUP_IDENTIFIER_TYPES = ["email", "subscription_ref", "invoice_ref", "case_id"] as const;
export type LookupIdentifierType = (typeof LOOKUP_IDENTIFIER_TYPES)[number];

export type ResolveCustomerInput = {
  identifierType: LookupIdentifierType;
  identifierValue: string;
  reason: string;
};

export type ResolveCustomerResult = {
  receiptId: string;
  matched: boolean;
  // Rule 26: minimal safe fields only — never the raw email, never an
  // internal parentId leaked as a "customer ID" the caller could reuse
  // outside a bound case.
  displayName?: string;
  maskedEmail?: string;
  accountStatus?: string;
};

export type CreateSupportCaseInput = {
  receiptId: string;
  category: SupportCaseCategory;
  reason: string;
  idempotencyKey: string;
};

export type SupportCaseListFilters = {
  status?: SupportCaseStatus;
  category?: SupportCaseCategory;
  assignedToMe?: boolean;
  cursor?: string;
  limit?: number;
};

export type SupportCaseSummary = {
  caseId: string;
  category: SupportCaseCategory;
  status: SupportCaseStatus;
  priority: SupportCasePriority;
  assignedStaffAccountId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ParentSafeSection = {
  displayName: string | null;
  maskedEmail: string;
  accountStatus: string;
  accountCreatedAt: string;
};

export type LearnerSafeSection = {
  learnerId: string;
  displayName: string;
  ageBand: string | null;
  apps: Array<{ appId: string; appName: string; entitlementState: string }>;
};

export type ProgressSafeSection = {
  appId: string;
  currentLevel: string | null;
  nextDestination: string | null;
  integrityState: string;
};

export type BillingSafeSection = {
  subscriptionId: string;
  productName: string | null;
  billingCycleStatus: string;
  gracePaymentStatus: string | null;
  cancellationStatus: string | null;
  safeInvoiceSummary: string | null;
};

export type NotificationSafeSection = {
  notificationType: string;
  state: string;
  deliveryState: string | null;
};

export type TechnicalIssueSafeSection = {
  sessionId: string;
  status: string;
  lastUpdatedAt: string;
};

export type SupportCaseSnapshot = {
  caseId: string;
  category: SupportCaseCategory;
  status: SupportCaseStatus;
  priority: SupportCasePriority;
  assignedStaffAccountId: string | null;
  escalationRole: EscalationRole | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  parent: ParentSafeSection;
  learner?: LearnerSafeSection;
  progress?: ProgressSafeSection;
  billing?: BillingSafeSection;
  notifications?: NotificationSafeSection[];
  technicalIssue?: TechnicalIssueSafeSection;
};

export type SupportCaseNote = { noteId: string; staffAccountId: string; noteText: string; createdAt: string };

export type UpdateSupportCaseWorkflowInput = {
  expectedVersion: number;
  idempotencyKey: string;
  status?: SupportCaseStatus;
  category?: SupportCaseCategory;
  assignedStaffAccountId?: string | null;
  escalationRole?: EscalationRole | null;
  priority?: SupportCasePriority;
};

export type AddSupportCaseNoteInput = { noteText: string; idempotencyKey: string };
export type ReopenSupportCaseInput = { reason: string; idempotencyKey: string };

// Rule 21: 20-500 visible characters.
export function isValidReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 20 && trimmed.length <= 500;
}

// Rule 54: 1-4000 visible characters.
export function isValidNoteText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= 4000;
}

// Rule 55: notes must never carry password/passkey/payment-credential-shaped
// content — a defensive content filter, not a substitute for staff judgment.
const FORBIDDEN_NOTE_PATTERNS = [
  /\bpassword\s*[:=]/i, /\bpasskey\b/i, /\bcvv\b/i, /\bcard\s*number\b/i,
  /\b\d{13,19}\b/, // a bare long digit run (card-shaped)
];
export function containsForbiddenNoteContent(text: string): boolean {
  return FORBIDDEN_NOTE_PATTERNS.some((pattern) => pattern.test(text));
}
