import { resolveDbClient } from "@/lib/db-client";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import { classifyOrphanEntitlement, severityForCategory } from "@/lib/entitlement-integrity/contracts";
import { reconcilePaidCycle, writeReceipt, openOrUpdateIncident } from "@/lib/entitlement-integrity/repair";

export type EntitlementIntegritySweepInput = {
  environment: string; sourceDomains?: string[]; from?: string; to?: string;
  cursor?: string; limit: number; runIdempotencyKey: string;
};

export type EntitlementIntegritySweepResult = {
  processed: number; nextCursor: string | null;
  healthyCount: number; repairedCount: number; deferredCount: number; incidentsOpenedCount: number; errorsCount: number;
};

type SweepRunRow = {
  processed: number; next_cursor: string | null; healthy_count: number; repaired_count: number;
  deferred_count: number; incidents_opened_count: number; errors_count: number;
};

type BillingPageRow = { billing_period_id: string; status: string; subscription_id: string; subscription_version: number };

function toResult(row: SweepRunRow): EntitlementIntegritySweepResult {
  return { processed: row.processed, nextCursor: row.next_cursor, healthyCount: row.healthy_count,
    repairedCount: row.repaired_count, deferredCount: row.deferred_count,
    incidentsOpenedCount: row.incidents_opened_count, errorsCount: row.errors_count };
}

// EN-004 rules 5-7, 53, 55: bounded, id-cursor-paginated, environment-
// isolated, page-idempotent scheduled reconciliation — same shape as
// sweepDueLifecycleTransitions/runGraceExpirySweep, adapted to page
// billing_periods.id (the natural, already-ordered source key) rather than
// PR-004's composite (updated_at,learner_id,app_id) cursor, since this
// sweep's source table has no equivalent multi-column ordering need.
//
// The orphan-entitlement check (rule 31, ENTITLEMENT_WITHOUT_VERIFIED_SOURCE)
// is scoped to entitlement_cycles belonging to subscriptions already present
// in this page — a cycle whose subscription has zero billing_periods rows
// at all would need its own independent reverse-direction cursor, not built
// this pass (documented narrowing, not a silent gap).
export async function runEntitlementIntegritySweep(
  principalId: string, input: EntitlementIntegritySweepInput, now: Date,
): Promise<EntitlementIntegritySweepResult> {
  if (!input.runIdempotencyKey.trim() || !Number.isInteger(input.limit) || input.limit < 1) {
    throw new EntitlementIntegrityError("INVALID_REQUEST");
  }
  const db = resolveDbClient();
  const bounded = Math.max(1, Math.min(500, input.limit));
  const cursorKey = input.cursor ?? "";

  const cached = await db.get<SweepRunRow>(
    "select * from entitlement_integrity_sweep_runs where run_idempotency_key=? and cursor=?",
    [input.runIdempotencyKey, cursorKey],
  );
  if (cached) return toResult(cached);

  const rows = await db.all<BillingPageRow>(
    `select bp.id as billing_period_id, bp.status as status, s.id as subscription_id, s.version as subscription_version
     from billing_periods bp join subscriptions s on s.id=bp.subscription_id
     where s.provider_environment=? and bp.id>? order by bp.id limit ?`,
    [input.environment, cursorKey, bounded + 1],
  );
  const page = rows.slice(0, bounded);
  const nextCursor = rows.length > bounded ? page[page.length - 1].billing_period_id : null;

  let healthyCount = 0, repairedCount = 0, deferredCount = 0, incidentsOpenedCount = 0, errorsCount = 0;
  const subscriptionIds = new Set<string>();
  for (const row of page) {
    subscriptionIds.add(row.subscription_id);
    try {
      const result = await reconcilePaidCycle({ paidCycleId: row.billing_period_id, expectedSourceVersion: row.subscription_version,
        principalId, runIdempotencyKey: `${input.runIdempotencyKey}:${row.billing_period_id}`, now });
      if (result.action === "healthy") healthyCount += 1;
      else if (result.action === "repair") repairedCount += 1;
      else if (result.action === "defer") deferredCount += 1;
    } catch (error) {
      if (error instanceof EntitlementIntegrityError && error.code === "ENTITLEMENT_INTEGRITY_CONFLICT") incidentsOpenedCount += 1;
      else errorsCount += 1;
    }
  }

  for (const subscriptionId of subscriptionIds) {
    const cycles = await db.all<{ id: string; paid_cycle_id: string; status: string; source_event_hash: string }>(
      "select id,paid_cycle_id,status,source_event_hash from entitlement_cycles where subscription_id=?",
      [subscriptionId],
    );
    for (const cycle of cycles) {
      if (cycle.status !== "ready") continue;
      const verifiedSource = await db.get("select 1 from billing_periods where id=? and status='paid'", [cycle.paid_cycle_id]);
      const orphan = classifyOrphanEntitlement({ status: cycle.status as "ready" }, !!verifiedSource);
      if (orphan.classification === "quarantine") {
        const severity = severityForCategory(orphan.category!, {});
        await openOrUpdateIncident(db, { environment: input.environment, category: orphan.category!, severity,
          sourceType: "paid_cycle", sourceId: cycle.paid_cycle_id, targetType: "entitlement_cycle", targetId: cycle.id,
          expectedHash: null, actualHash: cycle.source_event_hash }, now);
        await writeReceipt(db, { sourceType: "paid_cycle", sourceId: cycle.paid_cycle_id, sourceVersion: null,
          sourceHash: null, expectedTargetHash: null, action: "incident", targetType: "entitlement_cycle",
          targetId: cycle.id, targetVersion: null, result: "failed", principalId, now });
        incidentsOpenedCount += 1;
      }
    }
  }

  await db.run(
    `insert into entitlement_integrity_sweep_runs(run_idempotency_key,cursor,environment,source_domains_json,
     window_from,window_to,principal_id,processed,healthy_count,repaired_count,deferred_count,
     incidents_opened_count,errors_count,next_cursor,created_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.runIdempotencyKey, cursorKey, input.environment, JSON.stringify(input.sourceDomains ?? []),
      input.from ?? null, input.to ?? null, principalId, page.length, healthyCount, repairedCount, deferredCount,
      incidentsOpenedCount, errorsCount, nextCursor, now.toISOString()],
  );

  return { processed: page.length, nextCursor, healthyCount, repairedCount, deferredCount, incidentsOpenedCount, errorsCount };
}
