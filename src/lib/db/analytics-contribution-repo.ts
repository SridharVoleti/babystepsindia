import { getDb } from "@/lib/db/client";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { AnalyticsError } from "@/lib/analytics/errors";
import { learnerDailyKey } from "@/lib/analytics/daily-key";
import type { ValidatedContribution } from "@/lib/analytics/validation";
import type { TrustedCounterEvent } from "@/lib/analytics/validation";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { kolkataCalendarDate } from "@/lib/analytics/kolkata-interval";

export type ContributionResult = {
  applied: boolean;
  activityDate: string;
  appId: string;
  levelKey: string;
};

export const UNASSIGNED_ANALYTICS_LEVEL = "unassigned";

export function registerAnalyticsLevel(appId: string, levelKey: string, now: Date = new Date()): void {
  const normalized = levelKey.trim();
  if (!normalized || normalized === UNASSIGNED_ANALYTICS_LEVEL) {
    throw new AnalyticsError("LEVEL_REGISTRATION_INVALID");
  }
  const timestamp = now.toISOString();
  try {
    getDb().prepare(
      `insert into app_analytics_levels(app_id,level_key,status,created_at,updated_at)
       values(?,?,'active',?,?)
       on conflict(app_id,level_key) do update set status='active',updated_at=excluded.updated_at`,
    ).run(appId, normalized, timestamp, timestamp);
  } catch (error) {
    if (String(error).includes("FOREIGN KEY")) throw new AnalyticsError("APP_NOT_FOUND");
    throw error;
  }
}

function assertAnalyticsLevelAllowed(appId: string, levelKey: string): void {
  if (levelKey === UNASSIGNED_ANALYTICS_LEVEL) return;
  const configured = getDb().prepare(
    "select 1 from app_analytics_levels where app_id=? and level_key=? and status='active'",
  ).get(appId, levelKey);
  if (!configured) throw new AnalyticsError("UNKNOWN_LEVEL_KEY");
}

// Business rule 11: each source operation carries a deterministic
// contribution id; a receipt row makes re-applying the same id a no-op
// so retries never double count into the buffer (AT-AN-001-08).
export function applyDailyContribution(input: ValidatedContribution): ContributionResult {
  const db = getDb();

  // Business rule 27 / AT-AN-001-21: soft-deleted/unknown apps reject
  // new contributions. learnerDailyKey() itself fails closed
  // (ANALYTICS_SECRET_MISSING) before any row is written if the
  // dedicated secret is unavailable (AT-AN-001-29).
  try {
    assertAppOperational(input.appId);
  } catch (error) {
    if (error instanceof AppRegistryError) throw new AnalyticsError(error.code);
    throw error;
  }
  assertAnalyticsLevelAllowed(input.appId, input.levelKey);
  const dailyKey = learnerDailyKey(input.learnerId, input.activityDate);

  const existingReceipt = db.prepare(
    "select 1 from analytics_contribution_receipts where contribution_id = ?",
  ).get(input.contributionId);
  if (existingReceipt) {
    return { applied: false, activityDate: input.activityDate, appId: input.appId, levelKey: input.levelKey };
  }

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare(
      "insert into analytics_contribution_receipts(contribution_id, activity_date) values(?, ?)",
    ).run(input.contributionId, input.activityDate);

    db.prepare(
      `insert into analytics_daily_buffer(
         activity_date, learner_daily_key, app_id, level_key, age_band,
         engaged_seconds, sessions_started, sessions_completed, sessions_interrupted, lessons_completed, updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?)
       on conflict(activity_date, learner_daily_key, app_id, level_key) do update set
         engaged_seconds = engaged_seconds + excluded.engaged_seconds,
         sessions_started = sessions_started + excluded.sessions_started,
         sessions_completed = sessions_completed + excluded.sessions_completed,
         sessions_interrupted = sessions_interrupted + excluded.sessions_interrupted,
         lessons_completed = lessons_completed + excluded.lessons_completed,
         age_band = excluded.age_band,
         updated_at = excluded.updated_at`,
    ).run(
      input.activityDate, dailyKey, input.appId, input.levelKey, input.ageBand,
      input.deltas.engagedSeconds, input.deltas.sessionsStarted, input.deltas.sessionsCompleted,
      input.deltas.sessionsInterrupted, input.deltas.lessonsCompleted, now,
    );
  });
  run();

  return { applied: true, activityDate: input.activityDate, appId: input.appId, levelKey: input.levelKey };
}

// HTTP contributors identify only the platform session and a named one-count
// event. Learner/app, level, Kolkata date and age band are resolved here;
// engaged time is always zero because only the session runtime may produce it.
export function applyTrustedCounterEvent(input: TrustedCounterEvent, now: Date = new Date()): ContributionResult {
  const source = getDb().prepare(`select ls.learner_id,ls.app_id,ls.current_level_key,l.date_of_birth
    from learner_sessions ls join learners l on l.id=ls.learner_id where ls.id=?`).get(input.learnerSessionId) as
    { learner_id: string; app_id: string; current_level_key: string | null; date_of_birth: string } | undefined;
  if (!source) throw new AnalyticsError("SESSION_NOT_FOUND");
  const activityDate = kolkataCalendarDate(now);
  const counters = { sessionsStarted: 0, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 };
  if (input.eventType === "session_started") counters.sessionsStarted = 1;
  else if (input.eventType === "session_completed") counters.sessionsCompleted = 1;
  else if (input.eventType === "session_interrupted") counters.sessionsInterrupted = 1;
  else counters.lessonsCompleted = 1;
  return applyDailyContribution({ activityDate, learnerId: source.learner_id, appId: source.app_id,
    levelKey: source.current_level_key ?? "unassigned", ageBand: deriveAgeBand(source.date_of_birth, activityDate),
    contributionId: input.contributionId, deltas: { engagedSeconds: 0, ...counters } });
}
