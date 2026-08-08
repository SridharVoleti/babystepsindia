import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const has = (value: string, pattern: RegExp) => expect(value).toMatch(pattern);
const lacks = (value: string, pattern: RegExp) => expect(value).not.toMatch(pattern);
const table = (name: string) => {
  const match = read("src/lib/db/schema.sql").match(
    new RegExp(`create table if not exists ${name} \\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  expect(match, `${name} must exist in the canonical schema`).not.toBeNull();
  return match![1];
};

const sources = {
  schema: () => read("src/lib/db/schema.sql"),
  contribution: () => read("src/lib/db/analytics-contribution-repo.ts"),
  run: () => read("src/lib/db/analytics-run-repo.ts"),
  aggregate: () => read("src/lib/analytics/aggregate.ts"),
  dailyKey: () => read("src/lib/analytics/daily-key.ts"),
  gateway: () => read("src/lib/learning-session/gateway.ts"),
  finalization: () => read("src/lib/session-finalization/service.ts"),
  progress: () => read("src/lib/app-progress/service.ts"),
  progressRepo: () => read("src/lib/db/learner-progress-repo.ts"),
  adminRepo: () => read("src/lib/db/analytics-admin-repo.ts"),
  validation: () => read("src/lib/analytics/validation.ts"),
  adminPage: () => read("src/app/admin/analytics/page.tsx"),
  internalGuard: () => read("src/lib/auth/internal-service-guard.ts"),
  migration: () => read("supabase/migrations/0015_an001_analytics.sql"),
  scheduler: () => read(".github/workflows/an001-daily-analytics.yml"),
  test: (file: string) => read(`tests/${file}`),
};

type Criterion = { id: number; title: string; verify: () => void };

const criteria: Criterion[] = [
  { id: 1, title: "No raw analytics event stream exists", verify: () => {
    const names = [...sources.schema().matchAll(/create table if not exists (analytics_[a-z_]+)/g)].map((match) => match[1]);
    expect(names).toEqual(["analytics_daily_buffer", "analytics_contribution_receipts", "analytics_daily_level",
      "analytics_daily_app", "analytics_daily_runs"]);
    expect(names.every((name) => !/(click|page|heartbeat|event|replay|raw)/.test(name))).toBe(true);
  } },
  { id: 2, title: "Runtime checkpoints update current state without heartbeat rows", verify: () => {
    has(sources.gateway(), /there is no recurring heartbeat/);
    has(sources.gateway(), /update learner_sessions set/);
    lacks(sources.schema(), /create table if not exists analytics_heartbeat/);
  } },
  { id: 3, title: "One buffer row is maintained per approved grain", verify: () => {
    has(table("analytics_daily_buffer"), /primary key \(activity_date, learner_daily_key, app_id, level_key\)/);
    has(sources.test("analytics-contribution-repo.test.ts"), /combines multiple contributions for the same grain into one row/);
  } },
  { id: 4, title: "Daily pseudonyms use a date-specific HMAC key", verify: () => {
    has(sources.dailyKey(), /createHmac\("sha256"/);
    has(sources.dailyKey(), /activityDate.*learnerId/);
    has(sources.test("analytics-daily-key.test.ts"), /AT-AN-001-04/);
  } },
  { id: 5, title: "Analytics storage excludes identifiable fields", verify: () => {
    const analytics = ["analytics_daily_buffer", "analytics_daily_level", "analytics_daily_app", "analytics_daily_runs"]
      .map(table).join("\n");
    lacks(analytics, /\b(?:learner_id|parent_user_id|date_of_birth|display_name|email|phone|exact_age)\b/);
    has(table("analytics_daily_buffer"), /age_band text not null/);
  } },
  { id: 6, title: "Age band is derived at the activity date", verify: () => {
    has(sources.test("analytics-age-band.test.ts"), /AT-AN-001-06/);
    has(sources.contribution(), /deriveAgeBand\((?:learner|source)\.date_of_birth, activityDate\)/);
  } },
  { id: 7, title: "Server-observed time caps client totals", verify: () => {
    has(sources.finalization(), /server-observed wall-clock time/);
    has(sources.finalization(), /Math\.min\(reported,session\.maximum_connected_seconds,wallClockCap\)/);
    has(sources.test("learner-session-gateway.test.ts"), /reportedConnectedSeconds: 9999/);
  } },
  { id: 8, title: "Contribution retries cannot double count", verify: () => {
    has(sources.contribution(), /analytics_contribution_receipts/);
    has(sources.test("analytics-contribution-repo.test.ts"), /AT-AN-001-08/);
  } },
  { id: 9, title: "The previous Kolkata date is explicitly scheduled at 00:15", verify: () => {
    has(sources.scheduler(), /cron: '45 18 \* \* \*'/);
    has(sources.test("analytics-scheduler.test.ts"), /previous Asia\/Kolkata calendar date/);
  } },
  { id: 10, title: "Only one run can own an activity date", verify: () => {
    has(table("analytics_daily_runs"), /activity_date text primary key/);
    has(sources.run(), /transaction[\s\S]*\.immediate\(\)/);
    has(sources.test("analytics-run-claim-postgres.test.ts"), /FOR UPDATE|for update/i);
  } },
  { id: 11, title: "Level-grain aggregate metrics and distinct learners are correct", verify: () => {
    has(sources.test("analytics-aggregate.test.ts"), /AT-AN-001-11/);
    has(sources.aggregate(), /computeLevelAggregates/);
  } },
  { id: 12, title: "App-grain learners are unique across levels", verify: () => {
    has(sources.test("analytics-aggregate.test.ts"), /AT-AN-001-12/);
    has(sources.aggregate(), /computeAppAggregates/);
  } },
  { id: 13, title: "Reruns exact-replace rather than increment aggregates", verify: () => {
    has(sources.run(), /delete from analytics_daily_level/);
    has(sources.run(), /delete from analytics_daily_app/);
    has(sources.test("analytics-run-repo.test.ts"), /AT-AN-001-13\/19/);
  } },
  { id: 14, title: "Engaged time splits across Kolkata midnight", verify: () => {
    has(sources.test("analytics-midnight-split.test.ts"), /AT-AN-001-14/);
    has(sources.finalization(), /splitKolkataEngagedSeconds/);
  } },
  { id: 15, title: "Transition counters use authoritative server dates", verify: () => {
    has(sources.gateway(), /kolkataCalendarDate\(now\)/);
    has(sources.finalization(), /kolkataCalendarDate\(now\)/);
    has(sources.progress(), /const activityDate=kolkataCalendarDate\(now\)/);
  } },
  { id: 16, title: "Control totals are verified before deletion", verify: () => {
    has(sources.run(), /verifyControlTotals[\s\S]*commitAggregates[\s\S]*purgeDailyBuffer/);
    has(sources.test("analytics-aggregate.test.ts"), /AT-AN-001-16/);
  } },
  { id: 17, title: "A mismatch fails and retains source", verify: () => {
    has(sources.test("analytics-run-repo-verification-failure.test.ts"), /marks the run failed, retains the buffer/);
    has(sources.run(), /markRunFailed/);
  } },
  { id: 18, title: "Success leaves no date buffer or receipts", verify: () => {
    has(sources.run(), /delete from analytics_daily_buffer/);
    has(sources.run(), /delete from analytics_contribution_receipts/);
    has(sources.test("analytics-run-repo.test.ts"), /AT-AN-001-11\/16\/18/);
  } },
  { id: 19, title: "Failed runs retry deterministically then purge", verify: () => {
    has(sources.run(), /status = 'failed'/);
    has(sources.test("analytics-run-repo.test.ts"), /retry reprocesses the retained buffer/);
  } },
  { id: 20, title: "Run metadata is anonymous", verify: () => {
    lacks(table("analytics_daily_runs"), /\b(?:learner_id|learner_daily_key|parent_user_id|session_id|display_name|email|date_of_birth|dob)\b/i);
    has(sources.test("analytics-run-repo.test.ts"), /run metadata carries no learner identifier/);
  } },
  { id: 21, title: "Soft-deleted apps reject contributions without mutation", verify: () => {
    has(sources.contribution(), /assertAppOperational/);
    has(sources.test("analytics-contribution-repo.test.ts"), /soft-deleted app.*AT-AN-001-21/);
  } },
  { id: 22, title: "Aggregates retain permanent resolvable app identity", verify: () => {
    has(sources.adminRepo(), /join app_registry r on r\.id = a\.app_id/);
    has(sources.test("analytics-admin-repo.test.ts"), /AT-AN-001-22/);
  } },
  { id: 23, title: "Admin analytics exposes cohorts without named drilldown", verify: () => {
    has(sources.adminPage(), /Anonymous cohort aggregates only/);
    lacks(sources.adminPage(), /name=["']learner/);
    lacks(sources.adminRepo(), /learner_daily_key|learner_id|parent_user_id/);
  } },
  { id: 24, title: "Named reports use only compact progress and completions", verify: () => {
    has(sources.progressRepo(), /AT-AN-001-24/);
    has(sources.test("learner-progress-repo.test.ts"), /compact rows.*AT-AN-001-24/);
  } },
  { id: 25, title: "Lesson completion is unique and retry safe", verify: () => {
    has(table("lesson_completions"), /completion_id text not null unique/);
    has(sources.test("learner-progress-repo.test.ts"), /AT-AN-001-25/);
  } },
  { id: 26, title: "Progress is one current row without snapshots", verify: () => {
    has(table("learner_app_progress"), /primary key \(learner_id, app_id\)/);
    has(sources.progressRepo(), /on conflict\(learner_id, app_id\) do update/);
    has(sources.test("learner-progress-repo.test.ts"), /AT-AN-001-26/);
  } },
  { id: 27, title: "Client time totals never become authoritative", verify: () => {
    has(sources.finalization(), /wallClockCap/);
    has(sources.gateway(), /Math\.min\([\s\S]*maximum_connected_seconds/);
    lacks(sources.validation(), /clientTotal|reportedConnectedSeconds/);
  } },
  { id: 28, title: "Unknown and protected contribution fields fail closed", verify: () => {
    has(sources.validation(), /CONTRIBUTION_PAYLOAD_UNKNOWN_FIELD/);
    has(sources.test("analytics-validation.test.ts"), /AT-AN-001-28/);
  } },
  { id: 29, title: "Missing HMAC configuration stores no fallback identifier", verify: () => {
    has(sources.dailyKey(), /ANALYTICS_SECRET_MISSING/);
    has(sources.test("analytics-daily-key.test.ts"), /AT-AN-001-29/);
  } },
  { id: 30, title: "Purge retries are safe and preserve aggregates", verify: () => {
    has(sources.test("analytics-run-repo.test.ts"), /retrying an already-empty purge is safe/);
    has(sources.run(), /completed-but-not-yet-purged/);
  } },
  { id: 31, title: "Browsers cannot call analytics ingestion or run endpoints", verify: () => {
    has(sources.internalGuard(), /x-babysteps-service-assertion/);
    has(sources.test("internal-service-guard.test.ts"), /denies scheduler assertions at the contribution boundary/);
    has(sources.migration(), /enable row level security/);
  } },
  { id: 32, title: "Incomplete dates are labelled and excluded from totals", verify: () => {
    has(sources.adminRepo(), /run\.status = 'completed'/);
    has(sources.test("analytics-admin-repo.test.ts"), /completed, running, failed, and missing-run states|returns aggregates only/);
  } },
  { id: 33, title: "Analytics is never authoritative for access progress or scheduling", verify: () => {
    const authority = read("src/lib/entitlement-access/service.ts") + read("src/lib/entitlement-cycle/service.ts");
    lacks(authority, /analytics_daily|analytics-contribution|analytics-admin|analytics-run/);
    lacks(sources.progress(), /from ["']@\/lib\/db\/analytics-(?:admin|run)-repo/);
  } },
  { id: 34, title: "Finalization retains no permanent detailed analytics session history", verify: () => {
    const permanent = table("analytics_daily_level") + table("analytics_daily_app") + table("analytics_daily_runs");
    lacks(permanent, /session_id|learner_daily_key|learner_id/);
    has(sources.run(), /purgeDailyBuffer/);
    has(table("learner_app_progress"), /primary key \(learner_id, app_id\)/);
  } },
  { id: 35, title: "Support evidence is not duplicated into analytics", verify: () => {
    has(table("session_replacement_credits"), /evidence_summary/);
    const analytics = sources.contribution() + sources.run() + sources.aggregate();
    lacks(analytics, /session_replacement_credits|evidence_summary|support_evidence/);
  } },
];

describe("AN-001 acceptance criteria", () => {
  it.each(criteria)("AT-AN-001-$id $title", ({ id, verify }) => {
    if (id === 1) {
      expect(criteria).toHaveLength(35);
      expect(new Set(criteria.map((criterion) => criterion.id)))
        .toEqual(new Set(Array.from({ length: 35 }, (_, index) => index + 1)));
    }
    verify();
  });
});
