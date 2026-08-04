import { getDb } from "@/lib/db/client";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { AnalyticsError } from "@/lib/analytics/errors";
import { learnerDailyKey } from "@/lib/analytics/daily-key";
import type { ValidatedContribution } from "@/lib/analytics/validation";

export type ContributionResult = {
  applied: boolean;
  activityDate: string;
  appId: string;
  levelKey: string;
};

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
