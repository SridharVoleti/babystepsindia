import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";
import {
  beginGovernanceMutationReceipt, checkGovernanceMutationReplay, completeGovernanceMutationReceipt, hashMutationPayload,
} from "@/lib/platform-governance/mutation-idempotency";

// BR-002: "approx. every six months, test recovery in a restricted
// temporary project and destroy it afterward." The drill itself (restore
// via Supabase's own console, replay PC-004 deletions, reconcile billing,
// rebuild derivable state, validate critical flows) runs against a
// disposable temp project this production app never connects to — there
// is no live connection for this codebase to orchestrate. This module is
// the production-side compliance evidence ledger of that drill: who ran
// it, against which backup, what each step's outcome was, and whether
// the temp project was torn down. Never itself a live restore/rebuild
// orchestrator.
export class DisasterRecoveryError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DisasterRecoveryError";
  }
}

type StaffCaller = { staffAccountId: string };

export type RecoveryTestRecordView = {
  id: string;
  initiatedByStaffAccountId: string;
  backupReference: string;
  tempProjectReference: string;
  startedAt: string;
  outboundProcessingSuppressed: boolean;
  deletionReplayConfirmed: boolean;
  deletionReplayNotes: string | null;
  billingReconciliationConfirmed: boolean;
  billingReconciliationNotes: string | null;
  derivableStateRebuildConfirmed: boolean;
  derivableStateRebuildNotes: string | null;
  criticalFlowsValidated: boolean;
  criticalFlowsNotes: string | null;
  completedAt: string | null;
  teardownConfirmedAt: string | null;
  updatedAt: string;
};

function toView(row: Record<string, unknown>): RecoveryTestRecordView {
  return {
    id: row.id as string,
    initiatedByStaffAccountId: row.initiated_by_staff_account_id as string,
    backupReference: row.backup_reference as string,
    tempProjectReference: row.temp_project_reference as string,
    startedAt: row.started_at as string,
    outboundProcessingSuppressed: row.outbound_processing_suppressed === 1,
    deletionReplayConfirmed: row.deletion_replay_confirmed === 1,
    deletionReplayNotes: row.deletion_replay_notes as string | null,
    billingReconciliationConfirmed: row.billing_reconciliation_confirmed === 1,
    billingReconciliationNotes: row.billing_reconciliation_notes as string | null,
    derivableStateRebuildConfirmed: row.derivable_state_rebuild_confirmed === 1,
    derivableStateRebuildNotes: row.derivable_state_rebuild_notes as string | null,
    criticalFlowsValidated: row.critical_flows_validated === 1,
    criticalFlowsNotes: row.critical_flows_notes as string | null,
    completedAt: row.completed_at as string | null,
    teardownConfirmedAt: row.teardown_confirmed_at as string | null,
    updatedAt: row.updated_at as string,
  };
}

export type StartRecoveryTestInput = {
  backupReference: string;
  tempProjectReference: string;
  outboundProcessingSuppressed: boolean;
  idempotencyKey: string;
  now?: Date;
};

// Closure criterion: "recovery evidence records backup chosen... only
// Super Admin has default restore authority" — Super-Admin-only is
// enforced by the caller (the route), same as every other service in
// this codebase; this function trusts the caller was already gated.
export async function startRecoveryTestRecord(actor: StaffCaller, input: StartRecoveryTestInput): Promise<RecoveryTestRecordView> {
  const now = input.now ?? new Date();
  if (!input.backupReference.trim() || !input.tempProjectReference.trim()) {
    throw new DisasterRecoveryError("INVALID_REQUEST");
  }
  const requestHash = hashMutationPayload({
    backupReference: input.backupReference, tempProjectReference: input.tempProjectReference,
    outboundProcessingSuppressed: input.outboundProcessingSuppressed,
  });
  const replay = checkGovernanceMutationReplay(actor.staffAccountId, input.idempotencyKey, requestHash) as
    | RecoveryTestRecordView | undefined;
  if (replay !== undefined) return replay;

  const db = getDb();
  const timestamp = now.toISOString();
  const id = randomUUID();
  const result = db.transaction(() => {
    beginGovernanceMutationReceipt({
      actorStaffAccountId: actor.staffAccountId, idempotencyKey: input.idempotencyKey,
      canonicalAction: "admin.platform.recovery_test.start", targetReference: id, requestHash, now,
    });
    db.prepare(
      `insert into disaster_recovery_test_records
       (id,initiated_by_staff_account_id,backup_reference,temp_project_reference,started_at,
        outbound_processing_suppressed,updated_at)
       values (?,?,?,?,?,?,?)`,
    ).run(id, actor.staffAccountId, input.backupReference.trim(), input.tempProjectReference.trim(),
      timestamp, input.outboundProcessingSuppressed ? 1 : 0, timestamp);
    const view = toView(db.prepare("select * from disaster_recovery_test_records where id=?").get(id) as Record<string, unknown>);
    completeGovernanceMutationReceipt({ actorStaffAccountId: actor.staffAccountId, idempotencyKey: input.idempotencyKey, response: view, now });
    return view;
  })();
  await recordStaffAuditEvent({
    actorStaffAccountId: actor.staffAccountId, targetStaffAccountId: null,
    canonicalAction: "admin.platform.recovery_test.start", resourceType: "disaster_recovery_test_record",
    resourceSafeId: id, reason: `backup:${input.backupReference.trim()}`, result: "success", now,
  });
  return result;
}

export type RecoveryTestStepUpdate = {
  recordId: string;
  deletionReplay?: { confirmed: boolean; notes?: string };
  billingReconciliation?: { confirmed: boolean; notes?: string };
  derivableStateRebuild?: { confirmed: boolean; notes?: string };
  criticalFlows?: { confirmed: boolean; notes?: string };
  teardownConfirmed?: boolean;
  idempotencyKey: string;
  now?: Date;
};

// A single flexible updater rather than one endpoint per step — every
// field is optional, only the fields the caller actually supplies move.
// Completion (completed_at) is set the first time every one of the 4
// validation steps is confirmed; teardown is recorded independently
// (rule: teardown happens after validation, but is its own evidence
// field, not implied by it).
export async function updateRecoveryTestRecord(actor: StaffCaller, input: RecoveryTestStepUpdate): Promise<RecoveryTestRecordView> {
  const now = input.now ?? new Date();
  const requestHash = hashMutationPayload({ ...input, now: undefined });
  const replay = checkGovernanceMutationReplay(actor.staffAccountId, input.idempotencyKey, requestHash) as
    | RecoveryTestRecordView | undefined;
  if (replay !== undefined) return replay;

  const db = getDb();
  const existing = db.prepare("select * from disaster_recovery_test_records where id=?").get(input.recordId) as
    Record<string, unknown> | undefined;
  if (!existing) throw new DisasterRecoveryError("RECORD_NOT_FOUND");

  const timestamp = now.toISOString();
  const result = db.transaction(() => {
    beginGovernanceMutationReceipt({
      actorStaffAccountId: actor.staffAccountId, idempotencyKey: input.idempotencyKey,
      canonicalAction: "admin.platform.recovery_test.update", targetReference: input.recordId, requestHash, now,
    });

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.deletionReplay) {
      sets.push("deletion_replay_confirmed=?", "deletion_replay_notes=?");
      params.push(input.deletionReplay.confirmed ? 1 : 0, input.deletionReplay.notes ?? null);
    }
    if (input.billingReconciliation) {
      sets.push("billing_reconciliation_confirmed=?", "billing_reconciliation_notes=?");
      params.push(input.billingReconciliation.confirmed ? 1 : 0, input.billingReconciliation.notes ?? null);
    }
    if (input.derivableStateRebuild) {
      sets.push("derivable_state_rebuild_confirmed=?", "derivable_state_rebuild_notes=?");
      params.push(input.derivableStateRebuild.confirmed ? 1 : 0, input.derivableStateRebuild.notes ?? null);
    }
    if (input.criticalFlows) {
      sets.push("critical_flows_validated=?", "critical_flows_notes=?");
      params.push(input.criticalFlows.confirmed ? 1 : 0, input.criticalFlows.notes ?? null);
    }
    if (input.teardownConfirmed) {
      sets.push("teardown_confirmed_at=?");
      params.push(timestamp);
    }
    sets.push("updated_at=?");
    params.push(timestamp);
    if (sets.length > 1) {
      db.prepare(`update disaster_recovery_test_records set ${sets.join(",")} where id=?`).run(...params, input.recordId);
    }

    const merged = db.prepare("select * from disaster_recovery_test_records where id=?").get(input.recordId) as Record<string, unknown>;
    const allValidated = merged.deletion_replay_confirmed === 1 && merged.billing_reconciliation_confirmed === 1
      && merged.derivable_state_rebuild_confirmed === 1 && merged.critical_flows_validated === 1;
    if (allValidated && !merged.completed_at) {
      db.prepare("update disaster_recovery_test_records set completed_at=?,updated_at=? where id=?").run(timestamp, timestamp, input.recordId);
    }

    const view = toView(db.prepare("select * from disaster_recovery_test_records where id=?").get(input.recordId) as Record<string, unknown>);
    completeGovernanceMutationReceipt({ actorStaffAccountId: actor.staffAccountId, idempotencyKey: input.idempotencyKey, response: view, now });
    return view;
  })();
  await recordStaffAuditEvent({
    actorStaffAccountId: actor.staffAccountId, targetStaffAccountId: null,
    canonicalAction: "admin.platform.recovery_test.update", resourceType: "disaster_recovery_test_record",
    resourceSafeId: input.recordId, reason: "recovery_test_step_update", result: "success", now,
  });
  return result;
}

export function listRecoveryTestRecords(): RecoveryTestRecordView[] {
  const rows = getDb().prepare("select * from disaster_recovery_test_records order by started_at desc").all() as Array<Record<string, unknown>>;
  return rows.map(toView);
}

export function getRecoveryTestRecord(id: string): RecoveryTestRecordView | undefined {
  const row = getDb().prepare("select * from disaster_recovery_test_records where id=?").get(id) as Record<string, unknown> | undefined;
  return row ? toView(row) : undefined;
}
