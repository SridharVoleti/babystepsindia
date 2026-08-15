import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { NOTIFICATION_TYPE_REGISTRY, getNotificationTypeDefinition } from "@/lib/notifications/contracts";
import { renderNotificationTemplate } from "@/lib/notifications/templates";
import {
  ParentCommunicationHistoryRequestError,
  NOTIFICATION_HISTORY_CATEGORIES,
  toHistoryCategory,
  toHistoryDeliveryState,
  encodeHistoryCursor,
  decodeHistoryCursor,
  type CommunicationHistory,
  type NotificationHistoryCategory,
  type NotificationHistoryItem,
  type NotificationHistorySourceAction,
} from "./contracts";

export { ParentCommunicationHistoryRequestError };

const RETENTION_MONTHS = 13;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export type ParentCommunicationHistoryFilters = {
  category?: string;
  learnerId?: string;
  cursor?: string;
  limit?: string;
};

export type ParentCommunicationHistoryResult = Omit<CommunicationHistory, "nextCursor"> & { nextCursor: string | null };

type HistoryRow = {
  notification_id: string;
  notification_type: string;
  safe_variables: string;
  created_at: string;
  delivery_state: string | null;
};

// Rules 39-41/50-59: a source-owned route descriptor only — never a
// deep link to a specific historical record, since NT-001 stores no
// subscriptionId/refundCaseId, only display labels (rule 58: an old
// action always routes to the current owning summary, never a stale
// specific one). invoice_receipt_available/approved_service_notice have
// no real route to link to yet (no BI-005 document page, no service-status
// page anywhere in this codebase) — their action is correctly omitted
// rather than pointing nowhere real.
const SOURCE_ACTION_BY_TYPE: Record<string, NotificationHistorySourceAction | undefined> = {
  billing_renewal_reminder: { label: "Manage subscription", href: "/account/subscriptions" },
  billing_grace_started: { label: "Manage subscription", href: "/account/subscriptions" },
  billing_payment_recovered: { label: "Manage subscription", href: "/account/subscriptions" },
  billing_grace_expired: { label: "Manage subscription", href: "/account/subscriptions" },
  subscription_cancellation_scheduled: { label: "Manage subscription", href: "/account/subscriptions" },
  subscription_cancellation_reversed: { label: "Manage subscription", href: "/account/subscriptions" },
  billing_refund_outcome: { label: "Manage subscription", href: "/account/subscriptions" },
  account_email_changed: { label: "Account", href: "/account/security" },
  account_password_changed: { label: "Account", href: "/account/security" },
  invoice_receipt_available: undefined,
  approved_service_notice: undefined,
};

function historyVisibleTypeKeys(): string[] {
  return Object.values(NOTIFICATION_TYPE_REGISTRY).filter((def) => def.historyVisible).map((def) => def.key);
}

function typeKeysForFilter(category: NotificationHistoryCategory | undefined): string[] {
  const visible = historyVisibleTypeKeys();
  if (!category) return visible;
  return visible.filter((key) => toHistoryCategory(NOTIFICATION_TYPE_REGISTRY[key].category) === category);
}

function validateFilters(filters: ParentCommunicationHistoryFilters) {
  if (filters.category !== undefined && !NOTIFICATION_HISTORY_CATEGORIES.includes(filters.category as NotificationHistoryCategory)) {
    throw new ParentCommunicationHistoryRequestError("INVALID_CATEGORY");
  }
  let limit = DEFAULT_LIMIT;
  if (filters.limit !== undefined) {
    if (!/^\d+$/.test(filters.limit)) throw new ParentCommunicationHistoryRequestError("INVALID_LIMIT");
    limit = Number.parseInt(filters.limit, 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ParentCommunicationHistoryRequestError("INVALID_LIMIT");
  }
  const keyset = filters.cursor !== undefined ? decodeHistoryCursor(filters.cursor) : null;
  return { limit, keyset };
}

// Rules 43/74: no NT-001 row carries a structured learnerId — the parent's
// owned-learner list is only used to look up a display name to match
// against whichever type happens to have snapshotted one in safe_variables
// (today, only billing_renewal_reminder's optional learnerName). A
// foreign/unowned learnerId therefore matches nothing, never a leak
// (same "filtering can only narrow" discipline PD-003 already established).
function resolveLearnerNameFilter(parentId: string, learnerId: string | undefined, now: Date): string | null {
  if (!learnerId) return null;
  const ageAsOfDate = calendarDateInTimeZone(getParentTimezone(parentId));
  const owned = listOwnedLearners(parentId, ageAsOfDate).find((learner) => learner.id === learnerId);
  return owned?.displayName ?? null;
}

function toItem(row: HistoryRow): NotificationHistoryItem | null {
  const definition = getNotificationTypeDefinition(row.notification_type);
  if (!definition) return null; // rule 95: an unrecognized/corrupted row is safely omitted, never fabricated.
  let safeVariables: Record<string, unknown>;
  try {
    safeVariables = JSON.parse(row.safe_variables);
  } catch {
    return null;
  }
  let title: string;
  try {
    title = renderNotificationTemplate(row.notification_type, definition.templateVersion, safeVariables).subject;
  } catch {
    return null;
  }
  const learnerContext = typeof safeVariables.learnerName === "string" ? safeVariables.learnerName : undefined;
  const subscriptionContext = typeof safeVariables.subscriptionLabel === "string" ? safeVariables.subscriptionLabel : undefined;
  return {
    communicationId: row.notification_id,
    occurredAt: row.created_at,
    category: toHistoryCategory(definition.category),
    title,
    learnerContext,
    subscriptionContext,
    deliveryState: toHistoryDeliveryState(row.delivery_state ?? undefined),
    action: SOURCE_ACTION_BY_TYPE[row.notification_type],
  };
}

function computeVersion(items: NotificationHistoryItem[], nextCursor: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ items: items.map((item) => [item.communicationId, item.deliveryState]), nextCursor }))
    .digest("hex").slice(0, 32);
}

// API-NT-006: GET /v1/parent/communication-history. Parent-management,
// read-only, pure composition — never sends/retries/reconciles a provider,
// never creates PD-003 attention (rules 96-98). No new authoritative table
// (rules 69-70): every row is derived live from NT-001's own intents/
// deliveries plus the type registry's historyVisible/category metadata.
export function composeParentCommunicationHistory(
  parentId: string,
  filters: ParentCommunicationHistoryFilters,
  now: Date,
): ParentCommunicationHistoryResult {
  const { limit, keyset } = validateFilters(filters);
  const category = filters.category as NotificationHistoryCategory | undefined;
  const typeKeys = typeKeysForFilter(category);

  const emptyResult = (): ParentCommunicationHistoryResult =>
    ({ historyVersion: computeVersion([], null), retentionMonths: RETENTION_MONTHS, items: [], nextCursor: null });
  if (typeKeys.length === 0) return emptyResult();

  const learnerNameFilter = resolveLearnerNameFilter(parentId, filters.learnerId, now);
  if (filters.learnerId && learnerNameFilter === null) return emptyResult(); // rule 74/AT-36: unowned/no-match learnerId -> empty, not a leak.

  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  const typePlaceholders = typeKeys.map(() => "?").join(",");
  const params: unknown[] = [parentId, ...typeKeys, cutoff.toISOString()];
  let cursorClause = "";
  if (keyset) {
    cursorClause = " and (ti.created_at < ? or (ti.created_at = ? and ti.notification_id < ?))";
    params.push(keyset.createdAt, keyset.createdAt, keyset.notificationId);
  }
  params.push(limit + 1);

  const rows = getDb().prepare(
    `select ti.notification_id, ti.notification_type, ti.safe_variables, ti.created_at, td.state as delivery_state
     from transactional_notification_intents ti
     left join transactional_notification_deliveries td
       on td.notification_id = ti.notification_id and td.channel = 'email'
     where ti.parent_id = ? and ti.notification_type in (${typePlaceholders}) and ti.created_at >= ?${cursorClause}
     order by ti.created_at desc, ti.notification_id desc
     limit ?`,
  ).all(...params) as HistoryRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore
    ? encodeHistoryCursor({ createdAt: page[page.length - 1].created_at, notificationId: page[page.length - 1].notification_id })
    : null;

  let items = page.map(toItem).filter((item): item is NotificationHistoryItem => item !== null);
  if (learnerNameFilter !== null) {
    items = items.filter((item) => item.learnerContext === learnerNameFilter);
  }

  return {
    historyVersion: computeVersion(items, nextCursor),
    retentionMonths: RETENTION_MONTHS,
    items,
    nextCursor,
  };
}
