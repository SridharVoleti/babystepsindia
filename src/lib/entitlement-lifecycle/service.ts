import { randomUUID, createHash } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { EntitlementLifecycleError } from "@/lib/entitlement-lifecycle/errors";
import {
  resolveTransitionEffect,
  type LifecycleEventSource,
  type LifecycleEventType,
  type SessionEffect,
} from "@/lib/entitlement-lifecycle/contracts";
import { cancelStartingSessionsForLearnerApp, revokeActiveLearnerSessionsForLearnerApp } from "@/lib/learning-session/gateway";
import { clearLauncherAccessCache } from "@/lib/entitlement-access/launcher-cache";
import { reconcileLearnerRetentionState } from "@/lib/journey/service";

export type LifecycleSourceReference = {
  subscriptionId?: string;
  refundCaseId?: string;
  disputeId?: string;
  reassignmentCaseId?: string;
  learnerId: string;
  appId?: string;
  reasonCategory: string;
  policyEffect?: "terminate_now" | "no_change";
  fraudOrSecurityRisk?: boolean;
};

export type ApplyLifecycleEventInput = {
  eventId: string;
  eventType: LifecycleEventType;
  source: LifecycleEventSource;
  sourceVersion: number;
  effectiveAt: string;
  sourceReference: LifecycleSourceReference;
  now: Date;
};

export type AffectedEntitlementResult = {
  learnerId: string; appId: string; effectiveEntitlementId: string;
  previousState: string; newState: string; sessionEffect: SessionEffect;
};

export type ApplyLifecycleEventResult = { eventId: string; status: "applied"; affected: AffectedEntitlementResult[] };

type EventRow = {
  id: string; source: string; event_id: string; event_type: string; source_version: number; effective_at: string;
  subscription_id: string | null; refund_case_id: string | null; dispute_id: string | null;
  reassignment_case_id: string | null; learner_id: string; app_ids_json: string;
  reason_category: string; policy_effect: string | null; fraud_or_security_risk: number;
  status: string; payload_hash: string;
};

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identityColumnAndValue(ref: LifecycleSourceReference): { column: string; value: string } | null {
  if (ref.subscriptionId) return { column: "subscription_id", value: ref.subscriptionId };
  if (ref.refundCaseId) return { column: "refund_case_id", value: ref.refundCaseId };
  if (ref.disputeId) return { column: "dispute_id", value: ref.disputeId };
  if (ref.reassignmentCaseId) return { column: "reassignment_case_id", value: ref.reassignmentCaseId };
  return null;
}

// EN-003 rule 1: authoritative app-set resolution, never trusted from the
// caller. For subscription-scoped events this joins the subscription's own
// product/version (mirroring cancelStartingSessionsForSubscription in
// grace-policy.ts). Resolved once when an event is first recorded and then
// stored as its immutable app_ids_json snapshot (rule 3 — an event is bound
// to its exact app set) — retries and the sweep replay that stored set
// rather than re-querying, so a later product change can't alter what an
// already-recorded event affects.
async function resolveAffectedApps(ref: LifecycleSourceReference): Promise<string[]> {
  const db = resolveDbClient();
  if (ref.appId) {
    const app = await db.get("select 1 as x from app_registry where id=?", [ref.appId]);
    if (!app) throw new EntitlementLifecycleError("RESOURCE_NOT_FOUND");
    return [ref.appId];
  }
  if (!ref.subscriptionId) throw new EntitlementLifecycleError("RESOURCE_NOT_FOUND");
  const subscription = await db.get<{ product_id: string; product_version: number }>(
    "select product_id,product_version from subscriptions where id=?", [ref.subscriptionId]);
  if (!subscription) throw new EntitlementLifecycleError("RESOURCE_NOT_FOUND");
  const apps = await db.all<{ app_id: string }>(
    "select app_id from product_version_apps where product_id=? and product_version=?",
    [subscription.product_id, subscription.product_version]);
  if (apps.length === 0) throw new EntitlementLifecycleError("RESOURCE_NOT_FOUND");
  return apps.map((row) => row.app_id);
}

async function applySessionEffect(learnerId: string, appId: string, sessionEffect: SessionEffect, reason: string, now: Date) {
  if (sessionEffect === "cancel_starting" || sessionEffect === "preserve_to_hard_expiry") {
    await cancelStartingSessionsForLearnerApp(learnerId, appId, reason, now);
  } else if (sessionEffect === "immediate_revoke") {
    await revokeActiveLearnerSessionsForLearnerApp(learnerId, appId, reason, now);
  }
}

// Rules 4, 60, 66: applies an already-recorded event's effect to every
// affected (learner,app) row, atomically, safe to call more than once for
// the same event row — each per-app write is guarded by the
// (effective_entitlement_id, lifecycle_event_id) unique constraint on
// entitlement_state_transitions. This is what makes rule 67's "exact retry"
// safe whether it's driven by a repeat apply-lifecycle-event call or the
// process-due-transitions sweep.
async function applyRecordedEvent(row: EventRow, now: Date): Promise<ApplyLifecycleEventResult> {
  const db = resolveDbClient();
  const appIds = JSON.parse(row.app_ids_json) as string[];
  const effect = resolveTransitionEffect(row.event_type as LifecycleEventType,
    { fraudOrSecurityRisk: row.fraud_or_security_risk === 1 });
  const timestamp = now.toISOString();

  const affected = await resolveDbClient().transaction(async (db): Promise<AffectedEntitlementResult[]> => {
    const results: AffectedEntitlementResult[] = [];
    for (const appId of appIds) {
      const entitlement = await db.get<
        { id: string; state: string; lifecycle_version: number; revoked_before: string | null }>(
        `select id,state,lifecycle_version,revoked_before from learner_app_effective_entitlements
         where learner_id=? and app_id=?`,
        [row.learner_id, appId]);
      // No materialized entitlement yet for this learner+app (e.g. the
      // affected app was never purchased) — nothing to transition.
      if (!entitlement) continue;
      const alreadyApplied = await db.get(
        "select 1 as x from entitlement_state_transitions where effective_entitlement_id=? and lifecycle_event_id=?",
        [entitlement.id, row.id]);
      if (alreadyApplied) continue;

      const newState = effect.newState ?? entitlement.state;
      const nextLifecycleVersion = entitlement.lifecycle_version + 1;
      const revokedBefore = effect.sessionEffect === "immediate_revoke" ? timestamp
        : newState === "active" ? null : entitlement.revoked_before;

      await db.run(
        `update learner_app_effective_entitlements set state=?,lifecycle_version=?,last_lifecycle_event_id=?,
         revoked_before=?,updated_at=? where id=?`,
        [newState, nextLifecycleVersion, row.id, revokedBefore, timestamp, entitlement.id]);

      await db.run(
        `insert into entitlement_state_transitions(id,effective_entitlement_id,lifecycle_event_id,previous_state,
         new_state,effective_at,session_effect,reason_category,transition_version,result,created_at)
         values(?,?,?,?,?,?,?,?,?, 'applied',?)`,
        [randomUUID(), entitlement.id, row.id, entitlement.state, newState, row.effective_at,
          effect.sessionEffect, row.reason_category, nextLifecycleVersion, timestamp]);

      await applySessionEffect(row.learner_id, appId, effect.sessionEffect, `lifecycle:${row.event_type}`, now);

      results.push({ learnerId: row.learner_id, appId, effectiveEntitlementId: entitlement.id,
        previousState: entitlement.state, newState, sessionEffect: effect.sessionEffect });
    }
    return results;
  });

  const result: ApplyLifecycleEventResult = { eventId: row.event_id, status: "applied", affected };
  await db.run("update entitlement_lifecycle_events set status='applied',processed_at=?,updated_at=? where id=?",
    [timestamp, timestamp, row.id]);
  await db.run(
    `insert into entitlement_transition_receipts(lifecycle_event_id,request_hash,idempotency_status,result_json,
     attempt_count,created_at,updated_at) values(?,?, 'completed',?,1,?,?)
     on conflict(lifecycle_event_id) do update set idempotency_status='completed',result_json=excluded.result_json,
       attempt_count=entitlement_transition_receipts.attempt_count+1,updated_at=excluded.updated_at`,
    [row.id, row.payload_hash, JSON.stringify(result), timestamp, timestamp]);

  // Rule 5/6: launcher-only display cache invalidated on every committed
  // transition. Live enforcement (Start/exchange/usable-launch) always goes
  // through evaluateAccessFresh directly and is unaffected by this cache.
  clearLauncherAccessCache();
  try {
    await reconcileLearnerRetentionState(row.learner_id, new Date(row.effective_at), now);
  } catch {
    // EG-005 is a repairable projection; entitlement truth has already
    // committed and must never be rolled back by retention bookkeeping.
  }
  return result;
}

// EN-003's single entry point for every billing/identity/app/security
// lifecycle event (rules 1-70). Financial-truth-first ordering (rule 67):
// the event row commits in its own statement before the effect transaction
// runs; if the effect transaction throws, the event stays 'pending' and a
// repeat call with the same eventId (or the sweep) retries idempotently
// from the already-recorded row.
export async function applyLifecycleEvent(input: ApplyLifecycleEventInput): Promise<ApplyLifecycleEventResult> {
  const db = resolveDbClient();
  const canonical = { eventId: input.eventId, eventType: input.eventType, source: input.source,
    sourceVersion: input.sourceVersion, effectiveAt: input.effectiveAt, sourceReference: input.sourceReference };
  const payloadHash = hashPayload(canonical);
  const timestamp = input.now.toISOString();

  const existing = await db.get<EventRow>(
    "select * from entitlement_lifecycle_events where source=? and event_id=?", [input.source, input.eventId]);

  if (existing) {
    // Rule 61: exact duplicate (same source+event_id, same payload) is
    // idempotent; a different payload under the same event_id is rejected
    // outright (this is not the same as rule 63's same-*version*-different-
    // event conflict, handled below for genuinely new events).
    if (existing.payload_hash !== payloadHash) throw new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT");
    if (existing.status === "quarantined") throw new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT");
    if (existing.status === "applied") {
      const receipt = await db.get<{ result_json: string | null }>(
        "select result_json from entitlement_transition_receipts where lifecycle_event_id=?", [existing.id]);
      if (receipt?.result_json) return JSON.parse(receipt.result_json) as ApplyLifecycleEventResult;
    }
    return applyRecordedEvent(existing, input.now);
  }

  // Rules 62/63: staleness/conflict are scoped per (source, identity) — the
  // same subscription/refund-case/dispute/reassignment-case a prior applied
  // event for this exact source already touched.
  const identity = identityColumnAndValue(input.sourceReference);
  if (identity) {
    const latestApplied = await db.get<{ id: string; source_version: number }>(
      `select id,source_version from entitlement_lifecycle_events
       where source=? and ${identity.column}=? and status='applied' order by source_version desc limit 1`,
      [input.source, identity.value]);
    if (latestApplied && input.sourceVersion < latestApplied.source_version) {
      throw new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_VERSION_CONFLICT");
    }
    if (latestApplied && input.sourceVersion === latestApplied.source_version) {
      await db.run(
        `insert into entitlement_lifecycle_events(id,source,event_id,event_type,source_version,effective_at,
         subscription_id,refund_case_id,dispute_id,reassignment_case_id,learner_id,app_ids_json,environment,
         reason_category,policy_effect,fraud_or_security_risk,payload_hash,status,quarantine_reason,
         conflicting_event_id,received_at,created_at,updated_at)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'quarantined','CONFLICTING_SOURCE_VERSION',?,?,?,?)`,
        [randomUUID(), input.source, input.eventId, input.eventType, input.sourceVersion, input.effectiveAt,
          input.sourceReference.subscriptionId ?? null, input.sourceReference.refundCaseId ?? null,
          input.sourceReference.disputeId ?? null, input.sourceReference.reassignmentCaseId ?? null,
          input.sourceReference.learnerId, JSON.stringify(await resolveAffectedApps(input.sourceReference)), null,
          input.sourceReference.reasonCategory, input.sourceReference.policyEffect ?? null,
          input.sourceReference.fraudOrSecurityRisk ? 1 : 0, payloadHash, latestApplied.id,
          timestamp, timestamp, timestamp]);
      throw new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT");
    }
  }

  const appIds = await resolveAffectedApps(input.sourceReference);
  const eventId = randomUUID();
  await db.run(
    `insert into entitlement_lifecycle_events(id,source,event_id,event_type,source_version,effective_at,
     subscription_id,refund_case_id,dispute_id,reassignment_case_id,learner_id,app_ids_json,environment,
     reason_category,policy_effect,fraud_or_security_risk,payload_hash,status,received_at,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`,
    [eventId, input.source, input.eventId, input.eventType, input.sourceVersion, input.effectiveAt,
      input.sourceReference.subscriptionId ?? null, input.sourceReference.refundCaseId ?? null,
      input.sourceReference.disputeId ?? null, input.sourceReference.reassignmentCaseId ?? null,
      input.sourceReference.learnerId, JSON.stringify(appIds), null,
      input.sourceReference.reasonCategory, input.sourceReference.policyEffect ?? null,
      input.sourceReference.fraudOrSecurityRisk ? 1 : 0, payloadHash, timestamp, timestamp, timestamp]);

  const inserted = (await db.get<EventRow>("select * from entitlement_lifecycle_events where id=?", [eventId]))!;
  return applyRecordedEvent(inserted, input.now);
}

// EN-004 rule 27: a stuck 'pending' event (its insert committed but the
// per-app effect transaction never completed — e.g. an interrupted process)
// is retried through this exact same applyRecordedEvent path a repeat
// apply-lifecycle-event call or the sweep would use, never a fresh
// reconciliation-authored duplicate. Exported specifically for
// entitlement-integrity's reconcileLearnerApp to call by row id, since that
// module only knows "this learner+app has a pending event," not the
// original caller's exact (source,eventId) pair.
export async function applyPendingEventById(id: string, now: Date): Promise<ApplyLifecycleEventResult> {
  const row = await resolveDbClient().get<EventRow>("select * from entitlement_lifecycle_events where id=?", [id]);
  if (!row) throw new EntitlementLifecycleError("RESOURCE_NOT_FOUND");
  if (row.status !== "pending") throw new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT");
  return applyRecordedEvent(row, now);
}

async function beginLifecycleJob(principalId: string, jobType: "sweep" | "reconcile", key: string,
  requestHash: string, now: Date) {
  const db = resolveDbClient();
  const existing = await db.get<{ request_hash: string; status: string; result_json: string | null }>(
    `select request_hash,status,result_json from entitlement_lifecycle_job_runs
     where principal_id=? and job_type=? and run_idempotency_key=?`,
    [principalId, jobType, key]);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new EntitlementLifecycleError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status === "completed" && existing.result_json) return JSON.parse(existing.result_json);
    if (existing.status === "failed") {
      await db.run(
        `update entitlement_lifecycle_job_runs set status='running',result_json=null,completed_at=null,created_at=?
         where principal_id=? and job_type=? and run_idempotency_key=?`,
        [now.toISOString(), principalId, jobType, key]);
      return null;
    }
    throw new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT");
  }
  await db.run(
    `insert into entitlement_lifecycle_job_runs(principal_id,job_type,run_idempotency_key,request_hash,status,created_at)
     values(?,?,?,?,'running',?)`,
    [principalId, jobType, key, requestHash, now.toISOString()]);
  return null;
}

async function completeLifecycleJob(principalId: string, jobType: string, key: string,
  result: Record<string, unknown>, now: Date) {
  await resolveDbClient().run(
    `update entitlement_lifecycle_job_runs set status='completed',result_json=?,completed_at=?
     where principal_id=? and job_type=? and run_idempotency_key=?`,
    [JSON.stringify(result), now.toISOString(), principalId, jobType, key]);
  return result;
}

// Rules 64/67: bounded, paginated, resumable — retries events still
// 'pending' past their effective time (an interrupted apply-lifecycle-event
// call) using the same applyRecordedEvent path a repeat POST would use.
// scheduled_transition_at (learner_app_effective_entitlements) is schema
// support for a future scheduled-boundary producer — nothing in this build
// populates it yet, so that half of rule 64 is not yet reachable end-to-end
// (same category of gap as EN-001's not-yet-wired overlays).
export async function sweepDueLifecycleTransitions(principalId: string, input: {
  transitionType?: string; dueBefore: string; cursor?: string; limit: number; runIdempotencyKey: string;
}, now = new Date()) {
  if (!input.runIdempotencyKey.trim() || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new EntitlementLifecycleError("INVALID_REQUEST");
  }
  const requestHash = hashPayload(input);
  const replay = await beginLifecycleJob(principalId, "sweep", input.runIdempotencyKey, requestHash, now);
  if (replay) return replay;
  const db = resolveDbClient();
  const rows = await db.all<EventRow>(
    `select * from entitlement_lifecycle_events where status='pending' and effective_at<=? and id>?
     order by id limit ?`,
    [input.dueBefore, input.cursor ?? "", input.limit + 1]);
  const page = rows.slice(0, input.limit);
  let processed = 0;
  let errors = 0;
  for (const row of page) {
    try { await applyRecordedEvent(row, now); processed += 1; } catch { errors += 1; }
  }
  const nextCursor = rows.length > input.limit ? page.at(-1)!.id : null;
  return completeLifecycleJob(principalId, "sweep", input.runIdempotencyKey, { processed, errors, nextCursor }, now);
}

// Rule 47/48: chargeback reversal restoration is reachable *only* through
// this exact-reconciliation path, never the webhook alone — the webhook
// (financial-event-webhook.ts) records a 'chargeback_reversed'
// financial_dispute_events row but never applies it directly.
export async function reconcileEntitlementLifecycle(principalId: string, input: {
  subscriptionId?: string; learnerId?: string; appId?: string; sourceVersion?: number; runIdempotencyKey: string;
}, now = new Date()) {
  if (!input.runIdempotencyKey.trim()) throw new EntitlementLifecycleError("INVALID_REQUEST");
  const requestHash = hashPayload(input);
  const replay = await beginLifecycleJob(principalId, "reconcile", input.runIdempotencyKey, requestHash, now);
  if (replay) return replay;
  const db = resolveDbClient();
  const clauses = ["event_type='chargeback_reversed'", "status='received'"];
  const params: string[] = [];
  if (input.subscriptionId) { clauses.push("subscription_id=?"); params.push(input.subscriptionId); }
  const rows = await db.all<{ id: string; provider: string; provider_event_id: string; subscription_id: string; occurred_at: string }>(
    `select * from financial_dispute_events where ${clauses.join(" and ")} order by created_at limit 200`,
    params);
  const counts = { scanned: rows.length, restored: 0, skipped: 0, errors: 0 };
  for (const row of rows) {
    try {
      const subscription = await db.get<{ assigned_learner_id: string }>(
        "select assigned_learner_id from subscriptions where id=?", [row.subscription_id]);
      if (!subscription) { counts.errors += 1; continue; }
      // Rule 47: restore only when the original paid period still covers
      // the reversal moment — reconciliation never manufactures new access.
      const stillValid = await db.get(
        `select 1 as x from learner_app_entitlement_periods where subscription_id=? and period_start<=? and period_end>? limit 1`,
        [row.subscription_id, row.occurred_at, row.occurred_at]);
      if (!stillValid) {
        await db.run("update financial_dispute_events set status='processed',processed_at=? where id=?",
          [now.toISOString(), row.id]);
        counts.skipped += 1;
        continue;
      }
      const latest = await db.get<{ v: number | null }>(
        `select max(source_version) v from entitlement_lifecycle_events
         where source in ('billing_chargeback','reconciliation') and subscription_id=?`,
        [row.subscription_id]);
      await applyLifecycleEvent({
        eventId: `${row.provider}:${row.provider_event_id}`, eventType: "chargeback_reversed",
        source: "reconciliation", sourceVersion: (latest?.v ?? 0) + 1, effectiveAt: row.occurred_at,
        sourceReference: { subscriptionId: row.subscription_id, learnerId: subscription.assigned_learner_id,
          reasonCategory: "chargeback_reversed_reconciliation" },
        now,
      });
      await db.run("update financial_dispute_events set status='processed',processed_at=? where id=?",
        [now.toISOString(), row.id]);
      counts.restored += 1;
    } catch { counts.errors += 1; }
  }
  return completeLifecycleJob(principalId, "reconcile", input.runIdempotencyKey, counts, now);
}
