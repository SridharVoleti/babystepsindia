import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import { reconcilePaidCycle, reconcileLearnerApp } from "@/lib/entitlement-integrity/repair";

export type IncidentAction = "retry" | "resolve_false_positive" | "open_refund_case";

const RESOLVED_STATUSES = new Set(["resolved_repaired", "resolved_false_positive", "routed_refund_case"]);

type IncidentRow = {
  id: string; environment: string; category: string; source_type: string; source_id: string;
  target_type: string | null; target_id: string | null; expected_hash: string | null; actual_hash: string | null;
  severity: string; status: string; remediation_workflow: string; remediation_reference: string | null;
  assigned_operator_id: string | null; attempt_count: number; version: number;
  created_at: string; updated_at: string; resolved_at: string | null;
};

// EN-004 rules 44-45: a safe, external-facing view — technical identifiers
// and a mismatch category only, never a sensitive provider payload, payment
// instrument or raw progress (none of those fields exist on this row).
export function getSafeIncident(incidentId: string) {
  const incident = getDb().prepare("select * from entitlement_integrity_incidents where id=?").get(incidentId) as
    IncidentRow | undefined;
  if (!incident) throw new EntitlementIntegrityError("ENTITLEMENT_INTEGRITY_INCIDENT_NOT_FOUND");
  return {
    incidentId: incident.id, environment: incident.environment, category: incident.category,
    sourceType: incident.source_type, sourceId: incident.source_id, targetType: incident.target_type,
    targetId: incident.target_id, expectedHash: incident.expected_hash, actualHash: incident.actual_hash,
    severity: incident.severity, status: incident.status, remediationWorkflow: incident.remediation_workflow,
    remediationReference: incident.remediation_reference, assignedOperatorId: incident.assigned_operator_id,
    attemptCount: incident.attempt_count, version: incident.version, createdAt: incident.created_at,
    updatedAt: incident.updated_at, resolvedAt: incident.resolved_at,
    allowedActions: RESOLVED_STATUSES.has(incident.status) ? [] :
      ["retry", "resolve_false_positive", "open_refund_case"] as IncidentAction[],
  };
}

// Rule 56: aggregate counts only — no learner/payment identifiers at this
// surface, mirroring getProgressIntegrityHealth's shape.
export function getEntitlementIntegrityHealth(environment?: string) {
  const db = getDb();
  const envClause = environment ? "where environment=?" : "";
  const params = environment ? [environment] : [];
  const byStatus = db.prepare(`select status, count(*) as n from entitlement_integrity_incidents
    ${envClause} group by status`).all(...params) as Array<{ status: string; n: number }>;
  const openClause = environment ? "where environment=? and status in ('open','investigating')" : "where status in ('open','investigating')";
  const byCategory = db.prepare(`select category, count(*) as n from entitlement_integrity_incidents
    ${openClause} group by category`).all(...params) as Array<{ category: string; n: number }>;
  const openAges = db.prepare(`select created_at from entitlement_integrity_incidents ${openClause}`)
    .all(...params) as Array<{ created_at: string }>;
  const now = Date.now();
  const ageSecondsList = openAges.map((row) => Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000)));
  return {
    environment: environment ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.n])),
    openCountsByCategory: Object.fromEntries(byCategory.map((row) => [row.category, row.n])),
    openIncidentCount: openAges.length,
    oldestOpenIncidentAgeSeconds: ageSecondsList.length ? Math.max(...ageSecondsList) : null,
  };
}

export type ApplyIncidentActionInput = {
  incidentId: string; action: IncidentAction; actorAdminId: string; expectedVersion: number; idempotencyKey: string;
  reasonCategory?: string; refundCaseId?: string; now: Date;
};

export type ApplyIncidentActionResult = {
  incidentId: string; action: IncidentAction; result: "applied" | "rejected" | "no_op"; resultCode: string | null;
  incidentStatus: string;
};

type ActionReceiptRow = { action: string; result: string; result_code: string | null; new_incident_status: string | null };

// Rule 47: retry re-runs the exact same repair function a scheduled sweep
// would use against this incident's own source — never a direct edit. Only
// paid_cycle and effective_entitlement sources are independently
// repairable this way; a credit_batch incident is retried through its
// owning paid cycle, since SC-002 batches have no repair entry point of
// their own outside reconcilePaidCycle's batch-invariant check.
function retryRepair(incident: IncidentRow, actorAdminId: string, idempotencyKey: string, now: Date):
  { resolved: boolean; resultCode: string } {
  const db = getDb();
  try {
    if (incident.source_type === "paid_cycle") {
      const billingPeriod = db.prepare("select subscription_id from billing_periods where id=?").get(incident.source_id) as
        { subscription_id: string } | undefined;
      if (!billingPeriod) return { resolved: false, resultCode: "RETRY_SOURCE_NOT_FOUND" };
      const subscription = db.prepare("select version from subscriptions where id=?").get(billingPeriod.subscription_id) as
        { version: number };
      reconcilePaidCycle({ paidCycleId: incident.source_id, expectedSourceVersion: subscription.version,
        principalId: actorAdminId, runIdempotencyKey: idempotencyKey, now });
      return { resolved: true, resultCode: "RETRY_RESOLVED" };
    }
    if (incident.source_type === "credit_batch") {
      const period = db.prepare("select entitlement_cycle_id from learner_app_entitlement_periods where id=?")
        .get(incident.source_id) as { entitlement_cycle_id: string } | undefined;
      const cycle = period && db.prepare("select paid_cycle_id from entitlement_cycles where id=?")
        .get(period.entitlement_cycle_id) as { paid_cycle_id: string } | undefined;
      if (!cycle) return { resolved: false, resultCode: "RETRY_SOURCE_NOT_FOUND" };
      const billingPeriod = db.prepare("select subscription_id from billing_periods where id=?").get(cycle.paid_cycle_id) as
        { subscription_id: string };
      const subscription = db.prepare("select version from subscriptions where id=?").get(billingPeriod.subscription_id) as
        { version: number };
      reconcilePaidCycle({ paidCycleId: cycle.paid_cycle_id, expectedSourceVersion: subscription.version,
        principalId: actorAdminId, runIdempotencyKey: idempotencyKey, now });
      return { resolved: true, resultCode: "RETRY_RESOLVED" };
    }
    if (incident.source_type === "effective_entitlement") {
      const [learnerId, appId, environment] = incident.source_id.split(":");
      const effective = db.prepare(
        "select effective_version from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
      ).get(learnerId, appId, environment) as { effective_version: number } | undefined;
      if (!effective) return { resolved: false, resultCode: "RETRY_SOURCE_NOT_FOUND" };
      reconcileLearnerApp({ learnerId, appId, environment, expectedSourceVersion: effective.effective_version,
        principalId: actorAdminId, runIdempotencyKey: idempotencyKey, now });
      return { resolved: true, resultCode: "RETRY_RESOLVED" };
    }
    return { resolved: false, resultCode: "RETRY_NOT_APPLICABLE" };
  } catch {
    // Still conflicting/unresolved — the incident stays open for another pass.
    return { resolved: false, resultCode: "RETRY_STILL_CONFLICTING" };
  }
}

// EN-004 rules 46-49: the single dispatcher behind
// POST /v1/admin/entitlement-integrity-incidents/{id}/action. The route
// layer is responsible for the exact-permission + recent-reauthentication
// check before calling this.
export function applyIncidentAction(input: ApplyIncidentActionInput): ApplyIncidentActionResult {
  const db = getDb();
  const nowIso = input.now.toISOString();

  const replay = db.prepare(`select * from entitlement_integrity_incident_actions where incident_id=? and idempotency_key=?`)
    .get(input.incidentId, input.idempotencyKey) as ActionReceiptRow | undefined;
  if (replay) {
    if (replay.action !== input.action) throw new EntitlementIntegrityError("IDEMPOTENCY_KEY_REUSED");
    return { incidentId: input.incidentId, action: replay.action as IncidentAction,
      result: replay.result as ApplyIncidentActionResult["result"], resultCode: replay.result_code,
      incidentStatus: replay.new_incident_status! };
  }

  return db.transaction(() => {
    const incident = db.prepare("select * from entitlement_integrity_incidents where id=?").get(input.incidentId) as
      IncidentRow | undefined;
    if (!incident) throw new EntitlementIntegrityError("ENTITLEMENT_INTEGRITY_INCIDENT_NOT_FOUND");
    if (incident.version !== input.expectedVersion) throw new EntitlementIntegrityError("ENTITLEMENT_INTEGRITY_VERSION_CONFLICT");

    let result: ApplyIncidentActionResult["result"] = "applied";
    let resultCode: string | null = null;
    let newStatus = incident.status;

    if (input.action === "retry") {
      const retried = retryRepair(incident, input.actorAdminId, input.idempotencyKey, input.now);
      resultCode = retried.resultCode;
      if (retried.resolved) newStatus = "resolved_repaired";
      else result = "no_op";
    } else if (input.action === "resolve_false_positive") {
      if (!input.reasonCategory) { result = "rejected"; resultCode = "REASON_CATEGORY_REQUIRED"; }
      else { newStatus = "resolved_false_positive"; resultCode = "FALSE_POSITIVE_RESOLVED"; }
    } else if (input.action === "open_refund_case") {
      // Decision 5: fails closed without a real, pre-existing refund case —
      // this action only routes to Billing's existing refund flow, it never
      // grants access or edits credit balances itself (rule 47/AC32).
      if (!input.refundCaseId) { result = "rejected"; resultCode = "REFUND_CASE_REQUIRED"; }
      else {
        const refundCase = db.prepare("select id from refund_cases where id=?").get(input.refundCaseId);
        if (!refundCase) { result = "rejected"; resultCode = "REFUND_CASE_NOT_FOUND"; }
        else {
          db.prepare(`update entitlement_integrity_incidents set remediation_workflow='refund_case',
            remediation_reference=? where id=?`).run(input.refundCaseId, incident.id);
          newStatus = "routed_refund_case"; resultCode = "ROUTED_REFUND_CASE";
        }
      }
    }

    if (result !== "rejected" && newStatus !== incident.status) {
      db.prepare(`update entitlement_integrity_incidents set status=?, version=version+1, updated_at=?,
        resolved_at=? where id=?`)
        .run(newStatus, nowIso, RESOLVED_STATUSES.has(newStatus) ? nowIso : null, incident.id);
    } else if (result !== "rejected") {
      db.prepare(`update entitlement_integrity_incidents set attempt_count=attempt_count+1, version=version+1,
        updated_at=? where id=?`).run(nowIso, incident.id);
    }

    db.prepare(`insert into entitlement_integrity_incident_actions(id,incident_id,action,actor_admin_id,
      reauthenticated_at,expected_version,idempotency_key,reason_category,evidence_refs,result,result_code,
      prior_incident_status,new_incident_status,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), incident.id, input.action, input.actorAdminId, nowIso, input.expectedVersion,
        input.idempotencyKey, input.reasonCategory ?? null, "[]", result, resultCode,
        incident.status, newStatus, nowIso);

    return { incidentId: incident.id, action: input.action, result, resultCode, incidentStatus: newStatus };
  })();
}
