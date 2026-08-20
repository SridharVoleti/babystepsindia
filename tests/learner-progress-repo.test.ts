import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { activateApp, createApp, editApp } from "@/lib/db/app-registry-repo";
import {
  getLearnerAppProgress,
  getOwnedLearnerProgressReport,
  LearnerProgressReportError,
  listLessonCompletions,
  recordLessonCompletion,
  upsertLearnerAppProgress,
} from "@/lib/db/learner-progress-repo";
import type { EnvironmentReadinessAdapter } from "@/lib/app-registry/readiness-adapter";

let LEARNER_ID: string;
let APP_ID: string;
let OTHER_APP_ID: string;

function idemKey(n: number) {
  return `${"1".repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

const readyAdapter: EnvironmentReadinessAdapter = { checkReady: async () => ({ ready: true }) };

async function activeApp(appKey: string, idemSuffix: number) {
  const created = createApp(ADMIN, { appKey, displayName: appKey, idempotencyKey: idemKey(idemSuffix) });
  const edited = editApp(ADMIN, created.id, {
    shortDescription: "desc", iconAssetKey: "icon-chess-piece", category: "learning", owningTeam: "platform",
    expectedVersion: created.version, idempotencyKey: idemKey(idemSuffix + 100),
  });
  const activated = await activateApp(
    ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: idemKey(idemSuffix + 200) }, readyAdapter,
  );
  return activated.id;
}

let ADMIN: string;
let PARENT_ID: string;

beforeEach(async () => {
  useInMemoryDb();
  ADMIN = (await sqliteAuthAdapter.signUp("admin-actor@example.com", "CorrectHorse1!")).user.id;
  PARENT_ID = (await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!")).user.id;
  getDb().prepare("update profiles set onboarding_status='learner_pending' where id=?").run(PARENT_ID);
  LEARNER_ID = (await createLearner(PARENT_ID, {
    displayName: "Learner One", dateOfBirth: "2018-01-01", idempotencyKey: idemKey(1),
  }, "2026-08-04")).learner.id;
  APP_ID = await activeApp("chess-master", 2);
  OTHER_APP_ID = await activeApp("magical-math", 3);
});

describe("AU-002 parent-owned learner report", () => {
  it("AT-AU-002-15 returns only compact progress for the owning parent and hides foreign learners", async () => {
    await upsertLearnerAppProgress({ learnerId: LEARNER_ID, appId: APP_ID, currentLevelKey: "level-2",
      currentLessonKey: "lesson-3", currentEngagedSeconds: 90, appState: "private-runtime-state" });
    const report = await getOwnedLearnerProgressReport(PARENT_ID, LEARNER_ID);
    expect(report).toEqual([{ appId: APP_ID, appKey: "chess-master", appName: "chess-master",
      currentLevelKey: "level-2", currentLessonKey: "lesson-3", currentEngagedSeconds: 90,
      progressSummary: null }]);
    expect(JSON.stringify(report)).not.toContain("private-runtime-state");

    const foreign = (await sqliteAuthAdapter.signUp("foreign-parent@example.com", "CorrectHorse1!")).user.id;
    await expect(getOwnedLearnerProgressReport(foreign, LEARNER_ID))
      .rejects.toThrowError(new LearnerProgressReportError("RESOURCE_NOT_FOUND"));
  });
});

// AT-AN-001-26: no repeated progress snapshots — one current row/version.
describe("upsertLearnerAppProgress", () => {
  it("keeps exactly one row per learner+app, overwritten in place", async () => {
    await upsertLearnerAppProgress({ learnerId: LEARNER_ID, appId: APP_ID, currentLevelKey: "level-1", currentEngagedSeconds: 30 });
    await upsertLearnerAppProgress({ learnerId: LEARNER_ID, appId: APP_ID, currentLevelKey: "level-2", currentEngagedSeconds: 90 });

    const rows = getDb().prepare("select * from learner_app_progress").all();
    expect(rows).toHaveLength(1);

    const progress = await getLearnerAppProgress(LEARNER_ID, APP_ID);
    expect(progress).toMatchObject({ currentLevelKey: "level-2", currentEngagedSeconds: 90 });
  });

  it("tracks separate apps independently", async () => {
    await upsertLearnerAppProgress({ learnerId: LEARNER_ID, appId: APP_ID, currentLevelKey: "level-1" });
    await upsertLearnerAppProgress({ learnerId: LEARNER_ID, appId: OTHER_APP_ID, currentLevelKey: "level-9" });
    const rows = getDb().prepare("select * from learner_app_progress").all();
    expect(rows).toHaveLength(2);
  });

  it("returns null progress for a learner/app with no recorded state", async () => {
    expect(await getLearnerAppProgress(LEARNER_ID, OTHER_APP_ID)).toBeNull();
  });
});

describe("recordLessonCompletion", () => {
  // AT-AN-001-25: one row per learner/app/lesson, retry-safe.
  it("creates one row and reports applied:true for a new completion", async () => {
    const result = await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-1", levelKey: "level-1",
      completionId: "completion-1", completedAt: "2026-08-04T10:00:00.000Z", engagedSeconds: 120, result: "passed",
    });
    expect(result.applied).toBe(true);
    const rows = getDb().prepare("select * from lesson_completions").all();
    expect(rows).toHaveLength(1);
  });

  it("retrying the same completionId is a no-op — engaged seconds retained, no duplicate row", async () => {
    await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-1", levelKey: "level-1",
      completionId: "completion-1", completedAt: "2026-08-04T10:00:00.000Z", engagedSeconds: 120,
    });
    const retry = await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-1", levelKey: "level-1",
      completionId: "completion-1", completedAt: "2026-08-04T10:05:00.000Z", engagedSeconds: 999,
    });
    expect(retry.applied).toBe(false);
    const rows = getDb().prepare("select * from lesson_completions").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].engaged_seconds).toBe(120);
  });

  it("a genuine retake (new completionId, same lesson) overwrites the single row rather than appending history (AC26)", async () => {
    await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-1", levelKey: "level-1",
      completionId: "completion-1", completedAt: "2026-08-04T10:00:00.000Z", engagedSeconds: 120, result: "passed",
    });
    const retake = await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-1", levelKey: "level-1",
      completionId: "completion-2", completedAt: "2026-08-05T10:00:00.000Z", engagedSeconds: 90, result: "passed",
    });
    expect(retake.applied).toBe(true);
    const rows = getDb().prepare("select * from lesson_completions").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].engaged_seconds).toBe(90);
  });

  it("listLessonCompletions returns compact rows for a learner+app, usable for named parent reports (AT-AN-001-24)", async () => {
    await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-1", levelKey: "level-1",
      completionId: "completion-1", completedAt: "2026-08-04T10:00:00.000Z", engagedSeconds: 120, result: "passed",
    });
    await recordLessonCompletion({
      learnerId: LEARNER_ID, appId: APP_ID, lessonKey: "lesson-2", levelKey: "level-1",
      completionId: "completion-2", completedAt: "2026-08-04T10:10:00.000Z", engagedSeconds: 60, result: "passed",
    });
    const completions = await listLessonCompletions(LEARNER_ID, APP_ID);
    expect(completions).toHaveLength(2);
    expect(completions[0]).not.toHaveProperty("completionId");
  });
});
