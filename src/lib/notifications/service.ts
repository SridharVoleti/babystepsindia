import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { getNotificationTypeDefinition, validateSafeVariables } from "@/lib/notifications/contracts";
import { localTransactionalEmailProvider, type TransactionalEmailProvider } from
  "@/lib/notifications/provider-adapter";
import { resolveCurrentVerifiedParentEmail } from "@/lib/notifications/recipient";
import { renderNotificationTemplate } from "@/lib/notifications/templates";

export class NotificationServiceError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "NotificationServiceError"; }
}

export type EnqueueTransactionalNotificationInput = {
  notificationType: string;
  sourceDomain: string;
  sourceEventKey: string;
  sourceVersion: number;
  parentId: string;
  templateVersion?: string;
  safeVariables: Record<string, unknown>;
  // NT1-G01: the frozen API-NT-001 wire-contract identity. Optional here —
  // in-process callers (BI-002/003/004/005, IA-003) keep relying on the
  // natural-key unique constraint below as their identity; only the
  // API-NT-001 route always supplies one.
  idempotencyKey?: string;
};

export type EnqueueResult = { notificationId: string; state: string; templateVersion: string };

type IntentRow = {
  notification_id: string; parent_id: string; notification_type: string; source_domain: string;
  source_event_key: string; source_version: number; template_version: string; safe_variables: string;
  semantic_hash: string; idempotency_key: string | null; state: string; attempt_count: number;
  next_attempt_at: string | null; created_at: string; updated_at: string;
};

function semanticHash(input: { notificationType: string; sourceDomain: string; sourceEventKey: string;
  parentId: string; templateVersion: string; safeVariables: Record<string, unknown> }) {
  return createHash("sha256").update(JSON.stringify({
    notificationType: input.notificationType, sourceDomain: input.sourceDomain,
    sourceEventKey: input.sourceEventKey, parentId: input.parentId,
    templateVersion: input.templateVersion, safeVariables: input.safeVariables,
  })).digest("hex");
}

const PRINTABLE_ASCII_ONLY = /^[ -~]*$/;

function requireSourceEventKey(value: string) {
  if (!value || value.length > 200 || !PRINTABLE_ASCII_ONLY.test(value)) {
    throw new NotificationServiceError("INVALID_SOURCE_EVENT_KEY");
  }
}

// Rules 2-4, 23-25, 45-47: the deterministic identity is
// (notificationType, sourceDomain, sourceEventKey, parentId, templateVersion)
// — a replayed source event reuses the same logical intent (AT-24); the
// same identity with a different semantic payload is rejected and audited
// (AT-25) rather than silently overwritten. Callable directly from
// BI-*/IA-003 service code inside their own commit transaction (nested
// getDb() calls compose fine in this codebase, e.g. applyLifecycleEvent
// inside confirmProviderRefund) or via the API-NT-001 route as a thin
// wrapper for future external source services.
export function enqueueTransactionalNotification(
  input: EnqueueTransactionalNotificationInput,
  now = new Date(),
): EnqueueResult {
  const definition = getNotificationTypeDefinition(input.notificationType);
  if (!definition) throw new NotificationServiceError("UNKNOWN_NOTIFICATION_TYPE");
  if (input.sourceDomain !== definition.allowedSourceDomain) {
    throw new NotificationServiceError("SOURCE_DOMAIN_NOT_ALLOWED");
  }
  requireSourceEventKey(input.sourceEventKey);
  if (!Number.isInteger(input.sourceVersion) || input.sourceVersion < 0) {
    throw new NotificationServiceError("INVALID_SOURCE_VERSION");
  }
  const templateVersion = input.templateVersion ?? definition.templateVersion;
  if (templateVersion !== definition.templateVersion) throw new NotificationServiceError("UNKNOWN_TEMPLATE_VERSION");
  const validationError = validateSafeVariables(definition, input.safeVariables);
  if (validationError) throw new NotificationServiceError(validationError);

  const db = getDb();
  const parent = db.prepare("select id from users where id=?").get(input.parentId);
  if (!parent) throw new NotificationServiceError("RESOURCE_NOT_FOUND");

  const hash = semanticHash({ notificationType: input.notificationType, sourceDomain: input.sourceDomain,
    sourceEventKey: input.sourceEventKey, parentId: input.parentId, templateVersion,
    safeVariables: input.safeVariables });
  const timestamp = now.toISOString();
  const notificationId = randomUUID();
  const idempotencyKey = input.idempotencyKey ?? null;

  return db.transaction(() => {
    // NT1-G01: exact-once for the supplied idempotency identity — checked
    // first and independently of the natural-key insert below, so a replay
    // of the same idempotencyKey is recognized even before touching the
    // natural-key unique constraint that remains the identity mechanism for
    // in-process callers that never pass one.
    if (idempotencyKey !== null) {
      const byIdempotencyKey = db.prepare(
        "select * from transactional_notification_intents where idempotency_key=?",
      ).get(idempotencyKey) as IntentRow | undefined;
      if (byIdempotencyKey) {
        if (byIdempotencyKey.semantic_hash !== hash) throw new NotificationServiceError("NOTIFICATION_SEMANTIC_CONFLICT");
        return { notificationId: byIdempotencyKey.notification_id, state: byIdempotencyKey.state,
          templateVersion: byIdempotencyKey.template_version };
      }
    }

    db.prepare(
      `insert into transactional_notification_intents
       (notification_id,parent_id,notification_type,source_domain,source_event_key,source_version,
        template_version,safe_variables,semantic_hash,idempotency_key,state,attempt_count,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?, 'pending',0,?,?)
       on conflict(notification_type,source_domain,source_event_key,parent_id,template_version) do nothing`,
    ).run(notificationId, input.parentId, input.notificationType, input.sourceDomain, input.sourceEventKey,
      input.sourceVersion, templateVersion, JSON.stringify(input.safeVariables), hash, idempotencyKey,
      timestamp, timestamp);

    const row = db.prepare(
      `select * from transactional_notification_intents
       where notification_type=? and source_domain=? and source_event_key=? and parent_id=? and template_version=?`,
    ).get(input.notificationType, input.sourceDomain, input.sourceEventKey, input.parentId, templateVersion) as IntentRow;

    if (row.semantic_hash !== hash) throw new NotificationServiceError("NOTIFICATION_SEMANTIC_CONFLICT");
    return { notificationId: row.notification_id, state: row.state, templateVersion: row.template_version };
  })();
}

// Rules 65-67: bounded exponential backoff, never infinite (AT-34/35).
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240];

function ensureDeliveryRow(notificationId: string, timestamp: string): string {
  const db = getDb();
  const existing = db.prepare(
    "select id from transactional_notification_deliveries where notification_id=? and channel='email'",
  ).get(notificationId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `insert into transactional_notification_deliveries
     (id,notification_id,channel,provider_idempotency_key,state,attempt_count,created_at,updated_at)
     values(?,?,'email',?,'pending',0,?,?)`,
  ).run(id, notificationId, `unsent:${id}`, timestamp, timestamp);
  return id;
}

// Rules 51-52: claims a bounded batch via row locking (pending -> claimed,
// only if still pending, defends against a second concurrent worker),
// reloads authoritative recipient/state fresh for every attempt.
function deliverOne(intent: IntentRow, provider: TransactionalEmailProvider, now: Date): string {
  const db = getDb();
  const timestamp = now.toISOString();
  const deliveryId = ensureDeliveryRow(intent.notification_id, timestamp);

  // Rule 52/56, AT-28: fresh recipient resolution every attempt; no verified
  // email at send time is blocked_recipient, never a guessed address.
  const recipient = resolveCurrentVerifiedParentEmail(intent.parent_id);
  if (!recipient) {
    db.transaction(() => {
      db.prepare(
        "update transactional_notification_deliveries set state='blocked_recipient',last_attempt_at=?,updated_at=? where id=?",
      ).run(timestamp, timestamp, deliveryId);
      db.prepare(
        "update transactional_notification_intents set state='blocked_recipient',updated_at=? where notification_id=?",
      ).run(timestamp, intent.notification_id);
    })();
    return "blocked_recipient";
  }

  const rendered = renderNotificationTemplate(
    intent.notification_type, intent.template_version, JSON.parse(intent.safe_variables));

  // Rule 57: stable provider idempotency key derived from the logical
  // notification id, not regenerated per attempt, so a retried send never
  // double-delivers at the provider.
  const providerIdempotencyKey = `nt001:${intent.notification_id}`;
  let sendResult: ReturnType<TransactionalEmailProvider["send"]>;
  try {
    sendResult = provider.send({
      to: recipient.email, subject: rendered.subject, text: rendered.text, html: rendered.html,
      idempotencyKey: providerIdempotencyKey,
    });
  } catch {
    sendResult = { status: "failed" };
  }
  const attemptCount = intent.attempt_count + 1;

  // Rule 60-61, AT-30/31: accepted != inbox-delivered; delivered_when_known
  // only when the provider itself claims trustworthy delivery.
  if (sendResult.status === "accepted" || sendResult.status === "delivered") {
    const deliveryState = sendResult.status === "delivered" ? "delivered_when_known" : "accepted";
    db.transaction(() => {
      db.prepare(
        `update transactional_notification_deliveries
         set state=?,provider_message_id=?,provider_idempotency_key=?,attempt_count=?,accepted_at=?,
             delivered_at=?,last_attempt_at=?,updated_at=? where id=?`,
      ).run(deliveryState, sendResult.providerMessageId ?? null, providerIdempotencyKey, attemptCount, timestamp,
        deliveryState === "delivered_when_known" ? timestamp : null, timestamp, timestamp, deliveryId);
      db.prepare(
        "update transactional_notification_intents set state='sent',attempt_count=?,updated_at=? where notification_id=?",
      ).run(attemptCount, timestamp, intent.notification_id);
    })();
    return deliveryState;
  }

  // Rule 68: uncertain acceptance is left for reconcileNotificationDeliveries
  // to resolve before any further send is attempted — the intent stays
  // "claimed" (out of the pending-claim queue) rather than being rescheduled.
  if (sendResult.status === "uncertain") {
    db.transaction(() => {
      db.prepare(
        `update transactional_notification_deliveries
         set state='sending',provider_idempotency_key=?,attempt_count=?,last_attempt_at=?,updated_at=? where id=?`,
      ).run(providerIdempotencyKey, attemptCount, timestamp, timestamp, deliveryId);
      db.prepare(
        "update transactional_notification_intents set attempt_count=?,updated_at=? where notification_id=?",
      ).run(attemptCount, timestamp, intent.notification_id);
    })();
    return "sending";
  }

  // status === "failed": bounded retry with backoff, permanent past the cap
  // (rule 65-67, AT-34/35).
  if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    db.transaction(() => {
      db.prepare(
        `update transactional_notification_deliveries
         set state='permanent_failed',provider_idempotency_key=?,attempt_count=?,last_error_code='PROVIDER_REJECTED',
             last_attempt_at=?,updated_at=? where id=?`,
      ).run(providerIdempotencyKey, attemptCount, timestamp, timestamp, deliveryId);
      db.prepare(
        "update transactional_notification_intents set state='failed',attempt_count=?,updated_at=? where notification_id=?",
      ).run(attemptCount, timestamp, intent.notification_id);
    })();
    return "permanent_failed";
  }

  const backoffMinutes = RETRY_BACKOFF_MINUTES[Math.min(attemptCount - 1, RETRY_BACKOFF_MINUTES.length - 1)];
  const nextAttemptAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
  db.transaction(() => {
    db.prepare(
      `update transactional_notification_deliveries
       set state='temporary_failed',provider_idempotency_key=?,attempt_count=?,last_error_code='PROVIDER_TEMPORARY_ERROR',
           last_attempt_at=?,updated_at=? where id=?`,
    ).run(providerIdempotencyKey, attemptCount, timestamp, timestamp, deliveryId);
    db.prepare(
      `update transactional_notification_intents
       set state='pending',attempt_count=?,next_attempt_at=?,updated_at=? where notification_id=?`,
    ).run(attemptCount, nextAttemptAt, timestamp, intent.notification_id);
  })();
  return "temporary_failed";
}

export type NotificationDeliverySweepInput = { limit?: number; now?: Date; provider?: TransactionalEmailProvider };
export type NotificationDeliverySweepResult = {
  claimed: number;
  results: Array<{ notificationId: string; deliveryState: string }>;
};

// API-NT-002: bounded-batch worker. No dependency on browser sessions or
// heartbeats (rule 111) — a scheduler/cron principal calls this directly.
export function runNotificationDeliverySweep(input: NotificationDeliverySweepInput = {}): NotificationDeliverySweepResult {
  const now = input.now ?? new Date();
  const limit = Math.min(input.limit ?? 20, 100);
  const provider = input.provider ?? localTransactionalEmailProvider;
  const db = getDb();
  const timestamp = now.toISOString();

  const claimable = db.prepare(
    `select notification_id from transactional_notification_intents
     where state='pending' and (next_attempt_at is null or next_attempt_at<=?)
     order by created_at asc limit ?`,
  ).all(timestamp, limit) as { notification_id: string }[];

  const results: Array<{ notificationId: string; deliveryState: string }> = [];
  for (const { notification_id } of claimable) {
    const claimedIntent = db.transaction(() => {
      const changed = db.prepare(
        "update transactional_notification_intents set state='claimed',updated_at=? where notification_id=? and state='pending'",
      ).run(timestamp, notification_id).changes;
      if (changed !== 1) return null;
      return db.prepare("select * from transactional_notification_intents where notification_id=?")
        .get(notification_id) as IntentRow;
    })();
    if (!claimedIntent) continue;
    const deliveryState = deliverOne(claimedIntent, provider, now);
    results.push({ notificationId: notification_id, deliveryState });
  }
  return { claimed: results.length, results };
}

export class DeliveryRunConflictError extends Error {
  constructor() { super("DELIVERY_RUN_CONFLICT"); this.name = "DeliveryRunConflictError"; }
}
export class InvalidDeliveryRunCursorError extends Error {
  constructor() { super("INVALID_CURSOR"); this.name = "InvalidDeliveryRunCursorError"; }
}

export type DeliveryRunApiInput = {
  cursor?: string | null;
  limit: number;
  runIdempotencyKey: string;
  now?: Date;
  provider?: TransactionalEmailProvider;
};
export type DeliveryRunApiResult = {
  processed: number;
  accepted: number;
  tempFailed: number;
  permanentFailed: number;
  blocked: number;
  nextCursor: string | null;
};

function encodeDeliveryRunCursor(createdAt: string, notificationId: string): string {
  return Buffer.from(`${createdAt} ${notificationId}`, "utf-8").toString("base64url");
}

function decodeDeliveryRunCursor(cursor: string): { createdAt: string; notificationId: string } {
  let decoded: string;
  try { decoded = Buffer.from(cursor, "base64url").toString("utf-8"); } catch { throw new InvalidDeliveryRunCursorError(); }
  const parts = decoded.split(" ");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidDeliveryRunCursorError();
  return { createdAt: parts[0], notificationId: parts[1] };
}

// API-NT-002 (NT1-G03): the frozen POST /v1/internal/notifications/
// delivery-run contract layered on top of the same claim/deliver primitives
// runNotificationDeliverySweep (above) already uses — this function owns
// only the run-level shape (cursor, runIdempotencyKey, aggregate counters),
// never a second delivery mechanism. Rules AT-NT-002: same runIdempotencyKey
// replay never reprocesses; cursor continuation walks the claimable queue
// with no gaps/duplicates via a (created_at,notification_id) keyset.
export function runDeliveryRunApiV1(input: DeliveryRunApiInput): DeliveryRunApiResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new NotificationServiceError("INVALID_LIMIT");
  }
  if (!input.runIdempotencyKey || input.runIdempotencyKey.length > 200) {
    throw new NotificationServiceError("INVALID_RUN_IDEMPOTENCY_KEY");
  }
  const cursorBound = input.cursor ? decodeDeliveryRunCursor(input.cursor) : null;

  const now = input.now ?? new Date();
  const provider = input.provider ?? localTransactionalEmailProvider;
  const db = getDb();
  const timestamp = now.toISOString();

  const existingRun = db.prepare(
    "select state, result_json from notification_delivery_runs where run_idempotency_key=?",
  ).get(input.runIdempotencyKey) as { state: string; result_json: string | null } | undefined;
  if (existingRun) {
    if (existingRun.state === "completed" && existingRun.result_json) {
      return JSON.parse(existingRun.result_json) as DeliveryRunApiResult;
    }
    throw new DeliveryRunConflictError();
  }
  db.prepare(
    `insert into notification_delivery_runs(run_idempotency_key,state,created_at,updated_at)
     values(?,'running',?,?)`,
  ).run(input.runIdempotencyKey, timestamp, timestamp);

  const claimable = (cursorBound
    ? db.prepare(
        `select notification_id, created_at from transactional_notification_intents
         where state='pending' and (next_attempt_at is null or next_attempt_at<=?)
           and (created_at>? or (created_at=? and notification_id>?))
         order by created_at asc, notification_id asc limit ?`,
      ).all(timestamp, cursorBound.createdAt, cursorBound.createdAt, cursorBound.notificationId, input.limit)
    : db.prepare(
        `select notification_id, created_at from transactional_notification_intents
         where state='pending' and (next_attempt_at is null or next_attempt_at<=?)
         order by created_at asc, notification_id asc limit ?`,
      ).all(timestamp, input.limit)
  ) as { notification_id: string; created_at: string }[];

  let accepted = 0, tempFailed = 0, permanentFailed = 0, blocked = 0, processed = 0;
  let last: { notification_id: string; created_at: string } | null = null;
  for (const row of claimable) {
    const claimedIntent = db.transaction(() => {
      const changed = db.prepare(
        "update transactional_notification_intents set state='claimed',updated_at=? where notification_id=? and state='pending'",
      ).run(timestamp, row.notification_id).changes;
      if (changed !== 1) return null;
      return db.prepare("select * from transactional_notification_intents where notification_id=?")
        .get(row.notification_id) as IntentRow;
    })();
    last = row;
    if (!claimedIntent) continue;
    processed += 1;
    const deliveryState = deliverOne(claimedIntent, provider, now);
    if (deliveryState === "accepted" || deliveryState === "delivered_when_known") accepted += 1;
    else if (deliveryState === "temporary_failed") tempFailed += 1;
    else if (deliveryState === "permanent_failed") permanentFailed += 1;
    else if (deliveryState === "blocked_recipient") blocked += 1;
  }

  const nextCursor = last && claimable.length === input.limit
    ? encodeDeliveryRunCursor(last.created_at, last.notification_id) : null;
  const result: DeliveryRunApiResult = { processed, accepted, tempFailed, permanentFailed, blocked, nextCursor };
  db.prepare(
    "update notification_delivery_runs set state='completed',result_json=?,updated_at=? where run_idempotency_key=?",
  ).run(JSON.stringify(result), now.toISOString(), input.runIdempotencyKey);
  return result;
}

export type ReconcileNotificationDeliveriesInput = {
  limit?: number; now?: Date; provider?: TransactionalEmailProvider; staleAfterMinutes?: number;
};
export type ReconcileNotificationDeliveriesResult = {
  reconciled: number;
  results: Array<{ notificationId: string; outcome: "delivered_when_known" | "permanent_failed" | "still_uncertain" }>;
};

// API-NT-004: resolves deliveries stuck "sending" (uncertain provider
// acceptance) via provider.lookup, before any further send is attempted
// (rule 68, AT-36) — never blindly resends.
export function reconcileNotificationDeliveries(
  input: ReconcileNotificationDeliveriesInput = {},
): ReconcileNotificationDeliveriesResult {
  const now = input.now ?? new Date();
  const limit = Math.min(input.limit ?? 20, 100);
  const provider = input.provider ?? localTransactionalEmailProvider;
  const staleAfterMs = (input.staleAfterMinutes ?? 5) * 60_000;
  const db = getDb();
  const timestamp = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();

  const stuck = db.prepare(
    `select id as delivery_id, notification_id, provider_message_id, provider_idempotency_key
     from transactional_notification_deliveries
     where state='sending' and last_attempt_at<=? order by last_attempt_at asc limit ?`,
  ).all(staleBefore, limit) as Array<{
    delivery_id: string; notification_id: string; provider_message_id: string | null; provider_idempotency_key: string;
  }>;

  const results: ReconcileNotificationDeliveriesResult["results"] = [];
  for (const row of stuck) {
    const lookup = provider.lookup?.({ providerMessageId: row.provider_message_id, idempotencyKey: row.provider_idempotency_key })
      ?? { status: "pending" as const };
    if (lookup.status === "delivered") {
      db.transaction(() => {
        db.prepare(
          "update transactional_notification_deliveries set state='delivered_when_known',delivered_at=?,updated_at=? where id=?",
        ).run(timestamp, timestamp, row.delivery_id);
        db.prepare(
          "update transactional_notification_intents set state='sent',updated_at=? where notification_id=?",
        ).run(timestamp, row.notification_id);
      })();
      results.push({ notificationId: row.notification_id, outcome: "delivered_when_known" });
    } else if (lookup.status === "failed" || lookup.status === "not_found") {
      db.transaction(() => {
        db.prepare(
          "update transactional_notification_deliveries set state='permanent_failed',last_error_code='RECONCILE_UNRESOLVED',updated_at=? where id=?",
        ).run(timestamp, row.delivery_id);
        db.prepare(
          "update transactional_notification_intents set state='failed',updated_at=? where notification_id=?",
        ).run(timestamp, row.notification_id);
      })();
      results.push({ notificationId: row.notification_id, outcome: "permanent_failed" });
    } else {
      results.push({ notificationId: row.notification_id, outcome: "still_uncertain" });
    }
  }
  return { reconciled: results.length, results };
}

export function getNotificationIntentBySource(sourceDomain: string, sourceEventKey: string) {
  const rows = getDb().prepare(
    `select notification_id, parent_id, notification_type, state, attempt_count, created_at, updated_at
     from transactional_notification_intents where source_domain=? and source_event_key=?`,
  ).all(sourceDomain, sourceEventKey) as Array<Pick<IntentRow,
    "notification_id" | "parent_id" | "notification_type" | "state" | "attempt_count" | "created_at" | "updated_at">>;
  return rows.map((row) => ({
    notificationId: row.notification_id, parentId: row.parent_id, notificationType: row.notification_type,
    state: row.state, attemptCount: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}
