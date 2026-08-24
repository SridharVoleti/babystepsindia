import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";
import { computeCanonicalStateHash } from "@/lib/progress-integrity/service";
import { runReconciliationSweep } from "@/lib/progress-integrity/reconcile";

const now = new Date("2026-08-10T10:00:00.000Z");
const appId = "app-1";
const releaseId = "release-1";
const environment = "production";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  registerProgressSchema({ appId, releaseId, schemaVersion: 1,
    schemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }), now });
});

async function learnerWithProgress(opts: { badHash?: boolean; updatedAt: string; app?: string }) {
  const { user } = await sqliteAuthAdapter.signUp(`pr004recon-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner;
  const targetApp = opts.app ?? appId;
  const state = JSON.stringify({ level: "l1" });
  const hash = opts.badHash ? "tampered" : computeCanonicalStateHash({ learnerId: learner.id, appId: targetApp, environment,
    progressVersion: 1, schemaVersion: 1, serializedState: state });
  getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,
    state_hash,updated_at) values(?,?,1,?,1,?,?)`).run(learner.id, targetApp, state, hash, opts.updatedAt);
  return learner;
}

describe("PR-004 runReconciliationSweep", () => {
  it("processes every row across pages via cursor round-trip, in bounded order", async () => {
    await learnerWithProgress({ updatedAt: "2026-08-01T00:00:00.000Z" });
    await learnerWithProgress({ updatedAt: "2026-08-02T00:00:00.000Z" });
    await learnerWithProgress({ updatedAt: "2026-08-03T00:00:00.000Z" });

    const first = await runReconciliationSweep({ environment, limit: 2, runIdempotencyKey: "run-1", now });
    expect(first.processed).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await runReconciliationSweep({ environment, cursor: first.nextCursor!, limit: 2,
      runIdempotencyKey: "run-1-page-2", now });
    expect(second.processed).toBe(1);
    expect(second.nextCursor).toBeNull();
  });

  it("opens an incident for a hash-mismatched row discovered during the sweep", async () => {
    await learnerWithProgress({ badHash: true, updatedAt: "2026-08-01T00:00:00.000Z" });
    const result = await runReconciliationSweep({ environment, limit: 10, runIdempotencyKey: "run-2", now });
    expect(result.processed).toBe(1);
    expect(result.incidentsOpened).toBe(1);
    const incident = getDb().prepare(`select classification from progress_integrity_incidents`).get() as { classification: string };
    expect(incident.classification).toBe("unreadable_corrupt");
  });

  it("counts a repair when a blocked_repairable_metadata row is found already self-corrected", async () => {
    const learner = await learnerWithProgress({ updatedAt: "2026-08-01T00:00:00.000Z" });
    // Force blocked_repairable_metadata via a summary ahead of progress_version.
    getDb().prepare(`update learner_app_progress set progress_summary_json=?, progress_summary_based_on_version=5 where learner_id=?`)
      .run(JSON.stringify({ currentLevel: "L1", efficiencyStars: 1, milestone: null, nextDestination: "L2" }), learner.id);
    const first = await runReconciliationSweep({ environment, limit: 10, runIdempotencyKey: "run-3a", now });
    expect(first.repairsApplied).toBe(0); // first sighting, not yet "already blocked then fixed" within one pass window relative to itself
    // Now the underlying inconsistency is corrected by a normal write.
    getDb().prepare(`update learner_app_progress set progress_summary_based_on_version=1 where learner_id=?`).run(learner.id);
    const second = await runReconciliationSweep({ environment, limit: 10, runIdempotencyKey: "run-3b", now });
    expect(second.repairsApplied).toBe(1);
  });

  it("is idempotent: an identical runIdempotencyKey+cursor returns the cached result without reprocessing", async () => {
    await learnerWithProgress({ badHash: true, updatedAt: "2026-08-01T00:00:00.000Z" });
    const first = await runReconciliationSweep({ environment, limit: 10, runIdempotencyKey: "run-4", now });
    const countAfterFirst = (getDb().prepare(`select count(*) as n from progress_integrity_incidents`).get() as { n: number }).n;
    const second = await runReconciliationSweep({ environment, limit: 10, runIdempotencyKey: "run-4", now });
    const countAfterSecond = (getDb().prepare(`select count(*) as n from progress_integrity_incidents`).get() as { n: number }).n;
    expect(second).toEqual(first);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("scopes to a single app when appId is supplied", async () => {
    getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
      values('app-2','app-2','App Two','Learning app','icon-open-book','learning','team','active')`).run();
    registerProgressSchema({ appId: "app-2", releaseId, schemaVersion: 1,
      schemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }), now });
    await learnerWithProgress({ updatedAt: "2026-08-01T00:00:00.000Z", app: appId });
    await learnerWithProgress({ updatedAt: "2026-08-02T00:00:00.000Z", app: "app-2" });
    const result = await runReconciliationSweep({ appId, environment, limit: 10, runIdempotencyKey: "run-5", now });
    expect(result.processed).toBe(1);
  });
});

