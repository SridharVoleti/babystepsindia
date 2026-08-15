// NT-002: lightweight parent-management history of important NT-001
// transactional communications. Types only — the composer lives in
// service.ts. No new authoritative table (rules 69-70): every row here is
// derived at read time from NT-001's transactional_notification_intents/
// deliveries plus the type registry's category/historyVisible metadata.

// Ground-truth note (NT-002 survey): NT-001's registry has 4 internal
// categories (billing/financial_document/account_security/service), but
// rule 73's parent-facing filter surface is only 3 broad buckets — money-
// related types (billing + financial_document) fold into one "billing"
// bucket for NT-002's own display/filter contract.
export type NotificationHistoryCategory = "billing" | "account_security" | "service";

// Rules 30-38: a small, always-truthful vocabulary. "could_not_send" covers
// blocked_recipient/suppressed_by_policy (never actually dispatched) as
// distinct from a provider-side delivery failure. Never "opened"/"read" —
// the underlying delivery-state schema has no such state to claim.
export type NotificationHistoryDeliveryState =
  | "sending_or_delayed"
  | "sent"
  | "delivered"
  | "delivery_failed"
  | "could_not_send";

// Rules 50-58: a route descriptor only, never a mutation. NT-002 executes
// nothing — clicking always lands on the owning domain's current-state
// page, which independently reauthorizes (rule 56).
export type NotificationHistorySourceAction = { label: string; href: string };

export type NotificationHistoryItem = {
  communicationId: string;
  occurredAt: string;
  category: NotificationHistoryCategory;
  title: string;
  learnerContext?: string;
  appContext?: string;
  subscriptionContext?: string;
  deliveryState: NotificationHistoryDeliveryState;
  action?: NotificationHistorySourceAction;
};

export type CommunicationHistory = {
  historyVersion: string;
  retentionMonths: 13;
  items: NotificationHistoryItem[];
  nextCursor?: string;
};

export class ParentCommunicationHistoryRequestError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ParentCommunicationHistoryRequestError"; }
}

export const NOTIFICATION_HISTORY_CATEGORIES: NotificationHistoryCategory[] =
  ["billing", "account_security", "service"];

// Rule 20/26: internal registry categories -> the 3-bucket parent-facing
// filter surface (see module comment above).
export function toHistoryCategory(registryCategory: string): NotificationHistoryCategory {
  if (registryCategory === "billing" || registryCategory === "financial_document") return "billing";
  if (registryCategory === "account_security") return "account_security";
  return "service";
}

// Rules 31-35: deliveries.state is the source of truth once a delivery row
// exists (NT-001's deliverOne always creates one before any send attempt);
// an intent still queued with no delivery row yet reads as not-yet-sent.
export function toHistoryDeliveryState(deliveryState: string | undefined): NotificationHistoryDeliveryState {
  switch (deliveryState) {
    case "delivered_when_known": return "delivered";
    case "accepted": return "sent";
    case "permanent_failed": return "delivery_failed";
    case "blocked_recipient": return "could_not_send";
    case "suppressed_by_policy": return "could_not_send";
    default: return "sending_or_delayed"; // pending | sending | temporary_failed | no delivery row yet
  }
}

export type CommunicationHistoryCursor = { createdAt: string; notificationId: string };

const CURSOR_SEPARATOR = "|";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

// Opaque keyset cursor over (created_at desc, notification_id desc) — the
// same pair the parent-history index is built on. Deliberately not a plain
// offset (unlike PD-003's attention list): 13 months of history is a larger,
// more open-ended row count, and an offset-based page can skip/duplicate
// rows when new notifications land between reads.
export function encodeHistoryCursor(cursor: CommunicationHistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.notificationId}`, "utf8").toString("base64url");
}

export function decodeHistoryCursor(value: string): CommunicationHistoryCursor {
  if (!BASE64URL_PATTERN.test(value)) throw new ParentCommunicationHistoryRequestError("INVALID_CURSOR");
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const sepIndex = decoded.indexOf(CURSOR_SEPARATOR);
  if (sepIndex <= 0 || sepIndex === decoded.length - 1) throw new ParentCommunicationHistoryRequestError("INVALID_CURSOR");
  const createdAt = decoded.slice(0, sepIndex);
  const notificationId = decoded.slice(sepIndex + 1);
  if (Number.isNaN(Date.parse(createdAt))) throw new ParentCommunicationHistoryRequestError("INVALID_CURSOR");
  return { createdAt, notificationId };
}
