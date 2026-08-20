import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { readLearnerAppSummarySnapshot } from "@/lib/app-progress/summary-read";

const appId = "app-1";
let learnerId: string;

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  const { user } = await sqliteAuthAdapter.signUp(`ul001-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner.id;
});

describe("readLearnerAppSummarySnapshot", () => {
  it("returns exists:false with no summary when no progress row exists at all", async () => {
    const snapshot = await readLearnerAppSummarySnapshot(learnerId, appId);
    expect(snapshot).toEqual({ exists: false, summary: null, visibilityStatus: null });
  });

  it("returns a null summary when the progress row exists but never got a summary written", async () => {
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id) values(?,?)`).run(learnerId, appId);
    const snapshot = await readLearnerAppSummarySnapshot(learnerId, appId);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.summary).toBeNull();
    expect(snapshot.visibilityStatus).toBe("current");
  });

  it("returns the parsed summary and its visibility status when populated", async () => {
    const summary = { currentLevel: "L3", efficiencyStars: 4, milestone: "First 10 lessons", nextDestination: "L4" };
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,progress_summary_json,progress_summary_visibility_status)
      values(?,?,?,'stale')`).run(learnerId, appId, JSON.stringify(summary));
    const snapshot = await readLearnerAppSummarySnapshot(learnerId, appId);
    expect(snapshot).toEqual({ exists: true, summary, visibilityStatus: "stale" });
  });

  it("does not require an active or any learner_sessions row, unlike getCurrentProgress", async () => {
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,progress_summary_json)
      values(?,?,?)`).run(learnerId, appId, JSON.stringify({ currentLevel: "L1", efficiencyStars: 0, milestone: null, nextDestination: "L2" }));
    const sessionCountBefore = getDb().prepare(`select count(*) as n from learner_sessions`).get() as { n: number };
    expect(sessionCountBefore.n).toBe(0);
    const snapshot = await readLearnerAppSummarySnapshot(learnerId, appId);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.summary?.currentLevel).toBe("L1");
  });
});
