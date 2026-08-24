import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { ProgressIntegrityError } from "@/lib/progress-integrity/errors";
import { validateProgressIntegrity, type IntegrityClassification } from "@/lib/progress-integrity/service";

// PR-004 rule 63: the closed set of Version 1 incident actions. The
// dispatcher below never accepts current_state_json/schema_version/
// progress_version/summary/lesson-completion fields as input for any of
// them — rule 64 is enforced structurally by this fixed action shape, not
// by a runtime field-denylist.
export type IncidentAction =
  | "revalidate"
  | "retry_safe_metadata_repair"
  | "link_matching_receipt"
  | "resolve_legacy_policy"
  | "open_disaster_recovery_case"
  | "resolve_false_positive";

const RESOLVED_STATUSES = new Set(["resolved_repaired", "resolved_false_positive", "resolved_legacy_policy"]);

type IncidentRow = {
  id: string; app_id: string; environment: string; learner_id: string; classification: IntegrityClassification;
  severity: string; status: string; issue_codes: string; expected_state_hash: string | null; actual_state_hash: string | null;
  expected_progress_version: number | null; actual_progress_version: number | null; expected_schema_version: number | null;
  actual_schema_version: number | null; source_receipt_type: string | null; source_receipt_id: string | null;
  release_id: string | null; workflow_route: string; attempt_count: number; version: number;
  created_at: string; updated_at: string; resolved_at: string | null;
};

// PR-004 rule 60-61: a safe, external-facing view — app/environment,
// learner id (reference only, never a name), classification/severity/
// status, expected/actual hashes and versions, receipt/release references,
// and the closed action set currently legal for this incident. Never raw
// current_state, question data, answers or contact data (none of those
// fields exist on this row at all).
export async function getSafeIncident(incidentId: string) {
  const incident = await resolveDbClient().get<IncidentRow>("select * from progress_integrity_incidents where id=?", [incidentId]);
  if (!incident) throw new ProgressIntegrityError("PROGRESS_INTEGRITY_INCIDENT_NOT_FOUND");
  return {
    incidentId: incident.id, appId: incident.app_id, environment: incident.environment, learnerId: incident.learner_id,
    classification: incident.classification, severity: incident.severity, status: incident.status,
    issueCodes: JSON.parse(incident.issue_codes) as string[], expectedStateHash: incident.expected_state_hash,
    actualStateHash: incident.actual_state_hash, expectedProgressVersion: incident.expected_progress_version,
    actualProgressVersion: incident.actual_progress_version, expectedSchemaVersion: incident.expected_schema_version,
    actualSchemaVersion: incident.actual_schema_version, sourceReceiptType: incident.source_receipt_type,
    sourceReceiptId: incident.source_receipt_id, releaseId: incident.release_id, workflowRoute: incident.workflow_route,
    attemptCount: incident.attempt_count, version: incident.version, createdAt: incident.created_at,
    updatedAt: incident.updated_at, resolvedAt: incident.resolved_at,
    allowedActions: RESOLVED_STATUSES.has(incident.status) || incident.status === "routed_disaster_recovery" ? [] :
      ["revalidate", "retry_safe_metadata_repair", "link_matching_receipt", "resolve_legacy_policy",
        "open_disaster_recovery_case", "resolve_false_positive"] as IncidentAction[],
  };
}

// PR-004 rule 74: aggregate counts/classification/age/outcome only — no
// learner reference, no raw progress, at this surface.
export async function getProgressIntegrityHealth(appId: string, environment?: string) {
  const db = resolveDbClient();
  const envClause = environment ? "and environment=?" : "";
  const params = environment ? [appId, environment] : [appId];
  const byStatus = await db.all<{ status: string; n: number }>(`select status, count(*) as n from progress_integrity_incidents
    where app_id=? ${envClause} group by status`, params);
  const byClassification = await db.all<{ classification: string; n: number }>(`select classification, count(*) as n from progress_integrity_incidents
    where app_id=? ${envClause} and status in ('open','investigating') group by classification`, params);
  const openAges = await db.all<{ created_at: string }>(`select created_at from progress_integrity_incidents
    where app_id=? ${envClause} and status in ('open','investigating')`, params);
  const now = Date.now();
  const ageSecondsList = openAges.map((row) => Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000)));
  return {
    appId, environment: environment ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.n])),
    openCountsByClassification: Object.fromEntries(byClassification.map((row) => [row.classification, row.n])),
    openIncidentCount: openAges.length,
    oldestOpenIncidentAgeSeconds: ageSecondsList.length ? Math.max(...ageSecondsList) : null,
  };
}

export type ApplyIncidentActionInput = {
  incidentId: string; action: IncidentAction; actorAdminId: string; expectedVersion: number; idempotencyKey: string;
  reasonCategory?: string; receiptId?: string; now: Date;
};

export type ApplyIncidentActionResult = {
  incidentId: string; action: IncidentAction; result: "applied" | "rejected" | "no_op"; resultCode: string | null;
  incidentStatus: string; integrityState: IntegrityClassification;
};

type ActionReceiptRow = { action: string; result: string; result_code: string | null; new_incident_status: string | null;
  new_integrity_state: string | null };

// Re-runs the real classifier and reports whether the issue that justified
// this incident is now gone — the only way any action can move a
// blocked/corrupt row back toward healthy (rule 65: never a direct
// override; even resolve_false_positive can't force integrity_state).
async function reevaluate(incident: IncidentRow, now: Date) {
  return validateProgressIntegrity({ learnerId: incident.learner_id, appId: incident.app_id,
    environment: incident.environment, reason: "read", now });
}

const RESOLVING_CLASSIFICATIONS: IntegrityClassification[] = ["healthy", "read_only_safe"];

// PR-004 rules 63-66: the single dispatcher behind
// POST /v1/admin/progress-integrity-incidents/{id}/action. The route layer
// is responsible for the exact-permission + recent-reauthentication check
// (rule 62) before calling this — this function only records who acted
// (actorAdminId) and when, it doesn't itself verify credentials.
export async function applyIncidentAction(input: ApplyIncidentActionInput): Promise<ApplyIncidentActionResult> {
  const nowIso = input.now.toISOString();

  const replay = await resolveDbClient().get<ActionReceiptRow>(
    `select * from progress_integrity_incident_actions where incident_id=? and idempotency_key=?`,
    [input.incidentId, input.idempotencyKey]);
  if (replay) {
    if (replay.action !== input.action) throw new ProgressIntegrityError("IDEMPOTENCY_KEY_REUSED");
    return { incidentId: input.incidentId, action: replay.action as IncidentAction,
      result: replay.result as ApplyIncidentActionResult["result"], resultCode: replay.result_code,
      incidentStatus: replay.new_incident_status!, integrityState: replay.new_integrity_state as IntegrityClassification };
  }

  return resolveDbClient().transaction(async (db) => {
    const incident = await db.get<IncidentRow>("select * from progress_integrity_incidents where id=?", [input.incidentId]);
    if (!incident) throw new ProgressIntegrityError("PROGRESS_INTEGRITY_INCIDENT_NOT_FOUND");
    if (incident.version !== input.expectedVersion) throw new ProgressIntegrityError("PROGRESS_INTEGRITY_INCIDENT_VERSION_CONFLICT");

    const integrityRow = await db.get<{ integrity_state: IntegrityClassification }>(
      `select integrity_state from learner_app_progress_integrity where learner_id=? and app_id=?`,
      [incident.learner_id, incident.app_id]);
    const priorIntegrityState: IntegrityClassification = integrityRow?.integrity_state ?? "healthy";

    let result: ApplyIncidentActionResult["result"] = "applied";
    let resultCode: string | null = null;
    let newIntegrityState: IntegrityClassification = priorIntegrityState;
    let newIncidentStatus = incident.status;
    let evidenceRefs: string[] = [];

    if (input.action === "revalidate") {
      const revalidated = await reevaluate(incident, input.now);
      newIntegrityState = revalidated.classification;
      resultCode = RESOLVING_CLASSIFICATIONS.includes(revalidated.classification)
        ? "REVALIDATION_RESOLVED" : "REVALIDATION_STILL_BLOCKED";
      if (RESOLVING_CLASSIFICATIONS.includes(revalidated.classification)) newIncidentStatus = "resolved_repaired";
    } else if (input.action === "retry_safe_metadata_repair") {
      if (priorIntegrityState !== "blocked_repairable_metadata") {
        result = "rejected"; resultCode = "PROGRESS_INTEGRITY_ACTION_NOT_APPLICABLE";
      } else {
        // The metadata this action can fix (summary based_on_version
        // relation, migration-receipt linkage) is recomputed live on every
        // validateProgressIntegrity call — there is no separate stored fix
        // to apply beyond re-evaluating with current, possibly-since-
        // corrected data (rules 42-44: never touches current_state/
        // progress_version/schema_version/completions/summary values).
        const revalidated = await reevaluate(incident, input.now);
        newIntegrityState = revalidated.classification;
        if (RESOLVING_CLASSIFICATIONS.includes(revalidated.classification)) {
          newIncidentStatus = "resolved_repaired"; resultCode = "METADATA_REPAIR_RESOLVED";
        } else if (revalidated.classification === "blocked_repairable_metadata") {
          result = "no_op"; resultCode = "METADATA_UNCHANGED";
        } else {
          resultCode = "METADATA_REPAIR_STILL_BLOCKED";
        }
      }
    } else if (input.action === "link_matching_receipt") {
      if (!input.receiptId) { result = "rejected"; resultCode = "RECEIPT_ID_REQUIRED"; }
      else {
        const receipt = await db.get<{ to_schema_version: number }>(`select to_schema_version from learner_progress_migration_receipts
          where id=? and learner_id=? and app_id=?`, [input.receiptId, incident.learner_id, incident.app_id]);
        const progressRow = await db.get<{ schema_version: number }>(
          `select schema_version from learner_app_progress where learner_id=? and app_id=?`,
          [incident.learner_id, incident.app_id]);
        if (!receipt || !progressRow || receipt.to_schema_version !== progressRow.schema_version) {
          result = "rejected"; resultCode = "PROGRESS_INTEGRITY_RECEIPT_MISMATCH";
        } else {
          await db.run(`update learner_app_progress set last_migration_receipt_id=? where learner_id=? and app_id=?`,
            [input.receiptId, incident.learner_id, incident.app_id]);
          evidenceRefs = [input.receiptId];
          const revalidated = await reevaluate(incident, input.now);
          newIntegrityState = revalidated.classification;
          if (RESOLVING_CLASSIFICATIONS.includes(revalidated.classification)) {
            newIncidentStatus = "resolved_repaired"; resultCode = "RECEIPT_LINKED_RESOLVED";
          } else { resultCode = "RECEIPT_LINKED_STILL_BLOCKED"; }
        }
      }
    } else if (input.action === "resolve_legacy_policy") {
      if (priorIntegrityState !== "read_only_safe") {
        result = "rejected"; resultCode = "PROGRESS_INTEGRITY_ACTION_NOT_APPLICABLE";
      } else {
        await db.run(`update learner_app_progress_integrity set legacy_policy_acknowledged=1 where learner_id=? and app_id=?`,
          [incident.learner_id, incident.app_id]);
        const revalidated = await reevaluate(incident, input.now);
        newIntegrityState = revalidated.classification;
        newIncidentStatus = "resolved_legacy_policy"; resultCode = "LEGACY_POLICY_ACKNOWLEDGED";
      }
    } else if (input.action === "open_disaster_recovery_case") {
      // PR-004/PR-005 boundary: records the routing decision only — no
      // downstream disaster-recovery system exists in this codebase yet
      // (documented gap, same as PR-002's recovery receipts).
      newIncidentStatus = "routed_disaster_recovery"; resultCode = "ROUTED_DISASTER_RECOVERY";
    } else if (input.action === "resolve_false_positive") {
      if (!input.reasonCategory) { result = "rejected"; resultCode = "REASON_CATEGORY_REQUIRED"; }
      else { newIncidentStatus = "resolved_false_positive"; resultCode = "FALSE_POSITIVE_RESOLVED"; }
    }

    if (result !== "rejected" && newIncidentStatus !== incident.status) {
      await db.run(`update progress_integrity_incidents set status=?, workflow_route=?, version=version+1, updated_at=?,
        resolved_at=? where id=?`,
        [newIncidentStatus, input.action === "open_disaster_recovery_case" ? "disaster_recovery" : incident.workflow_route,
          nowIso, RESOLVED_STATUSES.has(newIncidentStatus) ? nowIso : null, incident.id]);
    } else if (result !== "rejected") {
      await db.run(`update progress_integrity_incidents set attempt_count=attempt_count+1, version=version+1, updated_at=? where id=?`,
        [nowIso, incident.id]);
    }

    await db.run(`insert into progress_integrity_incident_actions(id,incident_id,action,actor_admin_id,reauthenticated_at,
      expected_version,idempotency_key,reason_category,evidence_refs,result,result_code,prior_integrity_state,
      new_integrity_state,prior_incident_status,new_incident_status,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), incident.id, input.action, input.actorAdminId, nowIso, input.expectedVersion,
        input.idempotencyKey, input.reasonCategory ?? null, JSON.stringify(evidenceRefs), result, resultCode,
        priorIntegrityState, newIntegrityState, incident.status, newIncidentStatus, nowIso]);

    return { incidentId: incident.id, action: input.action, result, resultCode, incidentStatus: newIncidentStatus,
      integrityState: newIntegrityState };
  });
}

