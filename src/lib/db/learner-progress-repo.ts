import { getDb } from "@/lib/db/client";
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

export function upsertLearnerAppProgress(input: LearnerAppProgressInput): void {
  const db = getDb();
  db.prepare(
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
  ).run(
    input.learnerId, input.appId, input.currentLevelKey ?? null, input.currentLessonKey ?? null,
    input.currentEngagedSeconds ?? 0, input.appState ?? null, input.schemaVersion ?? 1,
    new Date().toISOString(),
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

export function getLearnerAppProgress(learnerId: string, appId: string): LearnerAppProgressView | null {
  const row = getDb().prepare(
    "select * from learner_app_progress where learner_id = ? and app_id = ?",
  ).get(learnerId, appId) as Record<string, unknown> | undefined;
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

export function getOwnedLearnerProgressReport(
  parentUserId: string,
  learnerId: string,
): OwnedLearnerProgressReportItem[] {
  const db = getDb();
  const owned = db.prepare("select 1 from learners where id=? and owner_parent_id=?")
    .get(learnerId, parentUserId);
  if (!owned) throw new LearnerProgressReportError("RESOURCE_NOT_FOUND");
  const rows = db.prepare(`select p.app_id,a.app_key,a.display_name,p.current_level_key,p.current_lesson_key,
    p.current_engaged_seconds from learner_app_progress p join app_registry a on a.id=p.app_id
    where p.learner_id=? order by a.display_name,a.id`).all(learnerId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const appId = String(row.app_id);
    const visibility = readProgressVisibilitySnapshot(learnerId, appId);
    const summary = visibility.readSafe ? readLearnerAppSummarySnapshot(learnerId, appId).summary : null;
    return { appId, appKey: String(row.app_key), appName: String(row.display_name),
      currentLevelKey: row.current_level_key as string | null,
      currentLessonKey: row.current_lesson_key as string | null,
      currentEngagedSeconds: Number(row.current_engaged_seconds), progressSummary: summary };
  });
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

export function recordLessonCompletion(
  input: RecordLessonCompletionInput,
): { applied: boolean; row: LessonCompletionRow } {
  const db = getDb();
  const existingByCompletionId = db.prepare(
    "select 1 from lesson_completions where completion_id = ?",
  ).get(input.completionId);

  if (existingByCompletionId) {
    const row = db.prepare(
      "select * from lesson_completions where learner_id = ? and app_id = ? and lesson_key = ?",
    ).get(input.learnerId, input.appId, input.lessonKey) as Record<string, unknown>;
    return { applied: false, row: toLessonCompletionRow(row) };
  }

  db.prepare(
    `insert into lesson_completions(
       learner_id, app_id, lesson_key, completion_id, level_key, completed_at, engaged_seconds, result)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(learner_id, app_id, lesson_key) do update set
       completion_id = excluded.completion_id,
       level_key = excluded.level_key,
       completed_at = excluded.completed_at,
       engaged_seconds = excluded.engaged_seconds,
       result = excluded.result`,
  ).run(
    input.learnerId, input.appId, input.lessonKey, input.completionId, input.levelKey,
    input.completedAt, input.engagedSeconds, input.result ?? null,
  );

  const row = db.prepare(
    "select * from lesson_completions where learner_id = ? and app_id = ? and lesson_key = ?",
  ).get(input.learnerId, input.appId, input.lessonKey) as Record<string, unknown>;
  return { applied: true, row: toLessonCompletionRow(row) };
}

// AT-AN-001-24: named parent reports use only compact progress and
// lesson-completion records — no session history required.
export function listLessonCompletions(learnerId: string, appId: string): LessonCompletionRow[] {
  const rows = getDb().prepare(
    "select * from lesson_completions where learner_id = ? and app_id = ? order by completed_at",
  ).all(learnerId, appId) as Record<string, unknown>[];
  return rows.map(toLessonCompletionRow);
}
