import { resolveDbClient } from "@/lib/db-client";
import { readLearnerAppSummarySnapshot } from "@/lib/app-progress/summary-read";
import { readProgressVisibilitySnapshot } from "@/lib/progress-integrity/service";

// Business rule 29/AT-AN-001-26: current state only, one row per
// learner+app, overwritten in place — never a versioned/append-only
// history table.
export type LearnerAppProgressInput = {
  learnerId: string;
  appId: string;
  currentLevelKey?: string | null;
  currentLessonKey?: string | null;
  currentEngagedSeconds?: number;
  appState?: string | null;
  schemaVersion?: number;
};

export async function upsertLearnerAppProgress(input: LearnerAppProgressInput): Promise<void> {
  await resolveDbClient().run(
    `insert into learner_app_progress(
       learner_id, app_id, current_level_key, current_lesson_key,
       current_engaged_seconds, app_state, schema_version, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(learner_id, app_id) do update set
       current_level_key = excluded.current_level_key,
       current_lesson_key = excluded.current_lesson_key,
       current_engaged_seconds = excluded.current_engaged_seconds,
       app_state = excluded.app_state,
       schema_version = excluded.schema_version,
       updated_at = excluded.updated_at`,
    [
      input.learnerId, input.appId, input.currentLevelKey ?? null, input.currentLessonKey ?? null,
      input.currentEngagedSeconds ?? 0, input.appState ?? null, input.schemaVersion ?? 1,
      new Date().toISOString(),
    ],
  );
}

export type LearnerAppProgressView = {
  currentLevelKey: string | null;
  currentLessonKey: string | null;
  currentEngagedSeconds: number;
  appState: string | null;
  schemaVersion: number;
  updatedAt: string;
};

export async function getLearnerAppProgress(learnerId: string, appId: string): Promise<LearnerAppProgressView | null> {
  const row = await resolveDbClient().get<Record<string, unknown>>(
    "select * from learner_app_progress where learner_id = ? and app_id = ?",
    [learnerId, appId],
  );
  if (!row) return null;
  return {
    currentLevelKey: row.current_level_key as string | null,
    currentLessonKey: row.current_lesson_key as string | null,
    currentEngagedSeconds: row.current_engaged_seconds as number,
    appState: row.app_state as string | null,
    schemaVersion: row.schema_version as number,
    updatedAt: row.updated_at as string,
  };
}

export class LearnerProgressReportError extends Error {
  constructor(public readonly code: "RESOURCE_NOT_FOUND") {
    super(code);
    this.name = "LearnerProgressReportError";
  }
}

export type OwnedLearnerProgressReportItem = {
  appId: string;
  appKey: string;
  appName: string;
  currentLevelKey: string | null;
  currentLessonKey: string | null;
  currentEngagedSeconds: number;
  progressSummary: import("@/lib/progress-motivation/contracts").ProgressSummary | null;
};

export async function getOwnedLearnerProgressReport(
  parentUserId: string,
  learnerId: string,
): Promise<OwnedLearnerProgressReportItem[]> {
  const db = resolveDbClient();
  const owned = await db.get("select 1 from learners where id=? and owner_parent_id=?", [learnerId, parentUserId]);
  if (!owned) throw new LearnerProgressReportError("RESOURCE_NOT_FOUND");
  const rows = await db.all<Record<string, unknown>>(
    `select p.app_id,a.app_key,a.display_name,p.current_level_key,p.current_lesson_key,
    p.current_engaged_seconds from learner_app_progress p join app_registry a on a.id=p.app_id
    where p.learner_id=? order by a.display_name,a.id`, [learnerId]);
  const result: OwnedLearnerProgressReportItem[] = [];
  for (const row of rows) {
    const appId = String(row.app_id);
    const visibility = await readProgressVisibilitySnapshot(learnerId, appId);
    const summary = visibility.readSafe ? (await readLearnerAppSummarySnapshot(learnerId, appId)).summary : null;
    result.push({ appId, appKey: String(row.app_key), appName: String(row.display_name),
      currentLevelKey: row.current_level_key as string | null,
      currentLessonKey: row.current_lesson_key as string | null,
      currentEngagedSeconds: Number(row.current_engaged_seconds), progressSummary: summary });
  }
  return result;
}

// Business rule 30/AT-AN-001-25: one row per learner/app/lesson.
// completion_id is the caller's deterministic idempotency key — a retry
// with the same id is a no-op (existing row/engaged seconds retained); a
// new id for the same lesson is a genuine retake and overwrites the
// single row in place rather than appending history (AT-AN-001-26).
export type RecordLessonCompletionInput = {
  learnerId: string;
  appId: string;
  lessonKey: string;
  levelKey: string;
  completionId: string;
  completedAt: string;
  engagedSeconds: number;
  result?: string | null;
};

export type LessonCompletionRow = {
  learnerId: string;
  appId: string;
  lessonKey: string;
  levelKey: string;
  completedAt: string;
  engagedSeconds: number;
  result: string | null;
};

function toLessonCompletionRow(row: Record<string, unknown>): LessonCompletionRow {
  return {
    learnerId: row.learner_id as string,
    appId: row.app_id as string,
    lessonKey: row.lesson_key as string,
    levelKey: row.level_key as string,
    completedAt: row.completed_at as string,
    engagedSeconds: row.engaged_seconds as number,
    result: row.result as string | null,
  };
}

export async function recordLessonCompletion(
  input: RecordLessonCompletionInput,
): Promise<{ applied: boolean; row: LessonCompletionRow }> {
  const db = resolveDbClient();
  const existingByCompletionId = await db.get(
    "select 1 from lesson_completions where completion_id = ?", [input.completionId]);

  if (existingByCompletionId) {
    const row = await db.get<Record<string, unknown>>(
      "select * from lesson_completions where learner_id = ? and app_id = ? and lesson_key = ?",
      [input.learnerId, input.appId, input.lessonKey],
    );
    return { applied: false, row: toLessonCompletionRow(row!) };
  }

  await db.run(
    `insert into lesson_completions(
       learner_id, app_id, lesson_key, completion_id, level_key, completed_at, engaged_seconds, result)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(learner_id, app_id, lesson_key) do update set
       completion_id = excluded.completion_id,
       level_key = excluded.level_key,
       completed_at = excluded.completed_at,
       engaged_seconds = excluded.engaged_seconds,
       result = excluded.result`,
    [
      input.learnerId, input.appId, input.lessonKey, input.completionId, input.levelKey,
      input.completedAt, input.engagedSeconds, input.result ?? null,
    ],
  );

  const row = await db.get<Record<string, unknown>>(
    "select * from lesson_completions where learner_id = ? and app_id = ? and lesson_key = ?",
    [input.learnerId, input.appId, input.lessonKey],
  );
  return { applied: true, row: toLessonCompletionRow(row!) };
}

// AT-AN-001-24: named parent reports use only compact progress and
// lesson-completion records — no session history required.
export async function listLessonCompletions(learnerId: string, appId: string): Promise<LessonCompletionRow[]> {
  const rows = await resolveDbClient().all<Record<string, unknown>>(
    "select * from lesson_completions where learner_id = ? and app_id = ? order by completed_at",
    [learnerId, appId],
  );
  return rows.map(toLessonCompletionRow);
}
