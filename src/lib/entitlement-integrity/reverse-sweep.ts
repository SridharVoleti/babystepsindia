import type { DbClient } from "@/lib/db-client/types";
import { resolveDbClient } from "@/lib/db-client";
import { clearLauncherAccessCache } from "@/lib/entitlement-access/launcher-cache";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import { classifyOrphanEntitlement, severityForCategory } from "@/lib/entitlement-integrity/contracts";
import { openOrUpdateIncident, writeReceipt } from "@/lib/entitlement-integrity/repair";
import type { EntitlementIntegritySweepInput, EntitlementIntegritySweepResult } from "@/lib/entitlement-integrity/sweep";

// PRG-039 / EN-004 reverse reconciliation (rule 31): start from the entitlement TARGET and ask whether verified Billing source truth
// backs it. The forward sweep (sweep.ts) is driven by billing_periods, so a cycle whose source rows or subscription were deleted is
// never reached by it. This sweep pages entitlement_cycles directly with its own id cursor.
//
// For every 'ready' cycle whose paid cycle is not a verified source (no such billing period, not 'paid' - e.g. rolled back -, or
// belonging to a different subscription) it, in ONE transaction and in this order:
//   1. opens (or updates) the single active ENTITLEMENT_WITHOUT_VERIFIED_SOURCE incident  - audit first,
//   2. writes the reconciliation receipt                                                  - audit first,
//   3. quarantines the effective entitlements derived from the cycle (integrity_state = 'quarantined'), which blocks NEW access
//      (evaluateAccessFresh) until an administrator resolves the incident.
// It only reads Billing; it never creates or edits entitlement/billing state from target state alone. Environment comes from the
// subscription, or - if the subscription is gone - from the effective entitlement the cycle feeds; a cycle that feeds no
// entitlement derives no access and is not in scope for any environment.
type CyclePageRow = { id: string; paid_cycle_id: string; subscription_id: string; status: string; source_event_hash: string; environment: string };
type RunRow = { processed: number; next_cursor: string | null; healthy_count: number; repaired_count: number; deferred_count: number; incidents_opened_count: number; errors_count: number };

const RUN_KEY_PREFIX = "reverse:";
// Lower bound for 'no cursor': ids are uuid on PostgreSQL, which rejects an empty string in comparisons.
const NIL_ID = "00000000-0000-0000-0000-000000000000";

function toResult(row: RunRow): EntitlementIntegritySweepResult {
  return { processed: row.processed, nextCursor: row.next_cursor, healthyCount: row.healthy_count, repairedCount: row.repaired_count,
    deferredCount: row.deferred_count, incidentsOpenedCount: row.incidents_opened_count, errorsCount: row.errors_count };
}

/** Clears the orphan quarantine for the effective entitlements fed by one entitlement cycle (used when its incident is resolved). */
export async function releaseOrphanQuarantine(db: DbClient, entitlementCycleId: string): Promise<number> {
  const released = await db.run(
    `update learner_app_effective_entitlements set integrity_state='healthy'
     where integrity_state='quarantined' and id in
       (select effective_entitlement_id from learner_app_entitlement_periods where entitlement_cycle_id=? and effective_entitlement_id is not null)`,
    [entitlementCycleId],
  );
  if (released.changes > 0) clearLauncherAccessCache();
  return released.changes;
}

export async function runReverseEntitlementIntegritySweep(
  principalId: string, input: EntitlementIntegritySweepInput, now: Date,
): Promise<EntitlementIntegritySweepResult> {
  if (!input.runIdempotencyKey.trim() || !Number.isInteger(input.limit) || input.limit < 1) throw new EntitlementIntegrityError("INVALID_REQUEST");
  const db = resolveDbClient();
  const bounded = Math.max(1, Math.min(500, input.limit));
  const cursorKey = input.cursor ?? "";
  const runKey = `${RUN_KEY_PREFIX}${input.runIdempotencyKey}`;

  const cached = await db.get<RunRow>("select * from entitlement_integrity_sweep_runs where run_idempotency_key=? and cursor=?", [runKey, cursorKey]);
  if (cached) return toResult(cached);

  const rows = await db.all<CyclePageRow>(
    `select ec.id, ec.paid_cycle_id, ec.subscription_id, ec.status, ec.source_event_hash, x.environment as environment
     from entitlement_cycles ec
     join (select ec2.id as cycle_id,
                  coalesce(s.provider_environment,
                           (select e.environment from learner_app_entitlement_periods p
                            join learner_app_effective_entitlements e on e.id = p.effective_entitlement_id
                            where p.entitlement_cycle_id = ec2.id limit 1)) as environment
           from entitlement_cycles ec2 left join subscriptions s on s.id = ec2.subscription_id) x on x.cycle_id = ec.id
     where x.environment = ? and ec.id > ? order by ec.id limit ?`,
    [input.environment, cursorKey || NIL_ID, bounded + 1],
  );
  const page = rows.slice(0, bounded);
  const nextCursor = rows.length > bounded ? page[page.length - 1].id : null;

  let healthyCount = 0, incidentsOpenedCount = 0, errorsCount = 0;
  for (const cycle of page) {
    try {
      const verified = await db.get(
        "select 1 from billing_periods where id=? and status='paid' and subscription_id=?", [cycle.paid_cycle_id, cycle.subscription_id]);
      const orphan = classifyOrphanEntitlement({ status: cycle.status as "creating" | "ready" | "failed" }, !!verified);
      if (orphan.classification !== "quarantine") { healthyCount += 1; continue; }
      await db.transaction(async (tx) => {
        await openOrUpdateIncident(tx, { environment: input.environment, category: orphan.category!, severity: severityForCategory(orphan.category!, {}),
          sourceType: "paid_cycle", sourceId: cycle.paid_cycle_id, targetType: "entitlement_cycle", targetId: cycle.id,
          expectedHash: null, actualHash: cycle.source_event_hash }, now);
        await writeReceipt(tx, { sourceType: "paid_cycle", sourceId: cycle.paid_cycle_id, sourceVersion: 0, sourceHash: null,       // 0 = no versioned source exists; keeps the receipt upsert idempotent (NULL never conflicts)
           expectedTargetHash: null,
          action: "incident", targetType: "entitlement_cycle", targetId: cycle.id, targetVersion: null, result: "failed", principalId, now });
        await tx.run(
          `update learner_app_effective_entitlements set integrity_state='quarantined'
           where environment=? and id in
             (select effective_entitlement_id from learner_app_entitlement_periods where entitlement_cycle_id=? and effective_entitlement_id is not null)`,
          [input.environment, cycle.id],
        );
      });
      clearLauncherAccessCache();
      incidentsOpenedCount += 1;
    } catch {
      errorsCount += 1;
    }
  }

  await db.run(
    `insert into entitlement_integrity_sweep_runs(run_idempotency_key,cursor,environment,source_domains_json,window_from,window_to,principal_id,processed,
     healthy_count,repaired_count,deferred_count,incidents_opened_count,errors_count,next_cursor,created_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [runKey, cursorKey, input.environment, JSON.stringify(["reverse"]), input.from ?? null, input.to ?? null, principalId, page.length,
      healthyCount, 0, 0, incidentsOpenedCount, errorsCount, nextCursor, now.toISOString()],
  );
  return { processed: page.length, nextCursor, healthyCount, repairedCount: 0, deferredCount: 0, incidentsOpenedCount, errorsCount };
}
