import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { invalidateLauncherFreshness, LauncherFreshnessError, reconcileLauncherFreshness } from
  "@/lib/learner-home/freshness-service";
import { composeLearnerHome } from "@/lib/learner-home/service";

const now = new Date("2026-08-11T12:00:00.000Z");
let learnerId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul003-${randomUUID()}@example.com`, "CorrectHorse1!");
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-11")).learner.id;
  getDb().prepare(`insert into platform_service_principals
    (id,service_key,key_ref,public_key,status,valid_from,valid_until,version) values
    ('launcher-outbox-id','learner-launcher-domain-outbox','test','','active','2026-08-01','2026-09-01',1),
    ('launcher-reconcile-id','learner-launcher-reconciliation','test','','active','2026-08-01','2026-09-01',1)`)
    .run();
});

describe("UL-003 freshness metadata", () => {
  it("binds launcherVersion and response freshness metadata to the exact learner-context generation", async () => {
    const first = await composeLearnerHome(learnerId, "production", now, 1);
    const switched = await composeLearnerHome(learnerId, "production", now, 2);
    expect(first).toMatchObject({ serverTime: now.toISOString(), composedAt: now.toISOString(),
      cacheMaxAgeSeconds: 60, selectedLearnerContextVersion: 1, nextRecheckAt: null });
    expect(switched.launcherVersion).not.toBe(first.launcherVersion);
    await invalidateLauncherFreshness("launcher-outbox-id", { learnerId, environment: "production",
      sourceType: "session", sourceVersion: 1, eventId: "version-event" }, now);
    expect((await composeLearnerHome(learnerId, "production", now, 1)).launcherVersion).not.toBe(first.launcherVersion);
  });

  it("records a metadata-only invalidation exactly once and never mutates launcher source domains", async () => {
    const before = {
      sessions: (getDb().prepare("select count(*) n from learner_sessions").get() as { n: number }).n,
      credits: (getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get() as { n: number }).n,
      progress: (getDb().prepare("select count(*) n from learner_app_progress").get() as { n: number }).n,
    };
    const input = { learnerId, environment: "production", sourceType: "session",
      sourceVersion: 2, eventId: "event-1" };
    const first = await invalidateLauncherFreshness("launcher-outbox-id", input, now);
    const replay = await invalidateLauncherFreshness("launcher-outbox-id", input, now);
    expect(replay).toEqual(first);
    expect(getDb().prepare("select invalidation_version,source_type,source_version from launcher_freshness_metadata")
      .get()).toMatchObject({ invalidation_version: 1, source_type: "session", source_version: "2" });
    expect(getDb().prepare("select count(*) n from learner_launcher_freshness_receipts").get())
      .toMatchObject({ n: 1 });
    expect({
      sessions: (getDb().prepare("select count(*) n from learner_sessions").get() as { n: number }).n,
      credits: (getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get() as { n: number }).n,
      progress: (getDb().prepare("select count(*) n from learner_app_progress").get() as { n: number }).n,
    }).toEqual(before);
  });

  it("rejects a lower monotonic source version without advancing freshness", async () => {
    await invalidateLauncherFreshness("launcher-outbox-id", { learnerId, environment: "production",
      sourceType: "session", sourceVersion: 2, eventId: "event-2" }, now);
    await expect(invalidateLauncherFreshness("launcher-outbox-id", { learnerId, environment: "production",
      sourceType: "session", sourceVersion: 1, eventId: "event-3" }, now))
      .rejects.toThrowError(new LauncherFreshnessError("SOURCE_VERSION_CONFLICT"));
    expect(getDb().prepare("select invalidation_version from launcher_freshness_metadata").get())
      .toMatchObject({ invalidation_version: 1 });
  });

  it("reconciles only derived hashes and returns an exact run replay", async () => {
    await invalidateLauncherFreshness("launcher-outbox-id", { learnerId, environment: "production",
      sourceType: "entitlement", sourceVersion: "source-1", eventId: "event-4" }, now);
    const input = { learnerId, environment: "production", limit: 10, runIdempotencyKey: "run-1" };
    const first = await reconcileLauncherFreshness("launcher-reconcile-id", input, now);
    const replay = await reconcileLauncherFreshness("launcher-reconcile-id", input, now);
    expect(first).toMatchObject({ repaired: 1, stale: 1, errors: 0, nextCursor: null });
    expect(replay).toEqual(first);
    expect(getDb().prepare("select invalidated_at,last_refresh_result,source_version_hash from launcher_freshness_metadata")
      .get()).toMatchObject({ invalidated_at: null, last_refresh_result: "reconciled" });
  });
});

