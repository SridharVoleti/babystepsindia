import { getDb } from "@/lib/db/client";
import type { ProgressSummary } from "@/lib/progress-motivation/contracts";

export type LearnerAppSummarySnapshot = {
  exists: boolean;
  summary: ProgressSummary | null;
  visibilityStatus: string | null;
};

// UL-001: reads the PR-003 summary independently of any active session —
// unlike getCurrentProgress() in service.ts, which requires an
// active/disconnected learner_sessions row via sessionFor() and is
// unusable for a cross-app launcher/home read. Parses without
// re-running validateProgressSummary — the value was already validated
// at write time (saveCheckpoint/completeLesson), and re-validating here
// would let a later schema tightening retroactively hide a previously
// valid stored summary.
export function readLearnerAppSummarySnapshot(learnerId: string, appId: string): LearnerAppSummarySnapshot {
  const row = getDb().prepare(
    `select progress_summary_json, progress_summary_visibility_status from learner_app_progress
     where learner_id=? and app_id=?`,
  ).get(learnerId, appId) as { progress_summary_json: string | null; progress_summary_visibility_status: string | null } | undefined;
  if (!row || !row.progress_summary_json) return { exists: !!row, summary: null, visibilityStatus: row?.progress_summary_visibility_status ?? null };
  try {
    return { exists: true, summary: JSON.parse(row.progress_summary_json), visibilityStatus: row.progress_summary_visibility_status };
  } catch {
    return { exists: true, summary: null, visibilityStatus: row.progress_summary_visibility_status };
  }
}
