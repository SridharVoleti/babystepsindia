import { resolveDbClient } from "@/lib/db-client";

// Rules 98-100: closed case CONTENT (notes/activity — the case row's own
// identity/binding metadata is kept for audit continuity) is retained 24
// months from closure, then purged. Source truth (billing, progress,
// account, notification records) is never touched by this sweep — it only
// ever deletes from the 3 support_case_* tables.
const CASE_CONTENT_RETENTION_MONTHS = 24;

export type SupportCaseRetentionPurgeResult = { notesPurged: number; activityPurged: number };

export async function purgeExpiredSupportCaseContent(
  now: Date = new Date(),
): Promise<SupportCaseRetentionPurgeResult> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - CASE_CONTENT_RETENTION_MONTHS);
  const cutoffIso = cutoff.toISOString();
  return resolveDbClient().transaction(async (tx) => {
    const expiredCaseIds = await tx.all<{ id: string }>(
      "select id from support_cases where status='closed' and closed_at is not null and closed_at < ?",
      [cutoffIso],
    );
    let notesPurged = 0;
    let activityPurged = 0;
    for (const { id } of expiredCaseIds) {
      notesPurged += (await tx.run("delete from support_case_notes where case_id=?", [id])).changes;
      activityPurged += (await tx.run("delete from support_case_activity where case_id=?", [id])).changes;
    }
    return { notesPurged, activityPurged };
  });
}
