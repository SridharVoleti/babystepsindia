// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { purgeLearnerJourneyIfDue, reconcileLearnerRetentionState } from "@/lib/journey/service";

// Real-PostgreSQL evidence for PRG-040 / EG-005 (issue #64): retention initialisation, purge and reactivation over separate pooled connections.
// Runs only when PG_TEST_URL points at a disposable, fully migrated database.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const ended = new Date("2026-08-11T04:30:00.000Z");
const due = new Date("2027-08-11T04:30:00.000Z");

suite("PRG-040 journey retention on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let parentId: string; let appId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    parentId = randomUUID(); appId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg040-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, registry_status) values (?, 'pg040-app', 'Journey App', 'Learning app', 'active')", [appId]);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  async function learner(entitlementState: "active" | "inactive") {
    const id = randomUUID();
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, ?, ?, '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [id, parentId, `L-${id}`, `l-${id}`]);
    await db().run(`insert into learner_app_effective_entitlements(id, learner_id, app_id, environment, state, access_until, effective_version, source_set_hash)
      values (?, ?, ?, 'production', ?, ?, 1, 'source')`, [randomUUID(), id, appId, entitlementState,
        entitlementState === "active" ? "2030-01-01T00:00:00Z" : ended.toISOString()]);
    return id;
  }
  const n = async (sql: string, ...a: string[]) => Number(((await db().get<{ n: string }>(sql, a)) ?? { n: "0" }).n);

  it("concurrent first-time retention initialisation creates exactly one state row and no caller fails", async () => {
    const id = await learner("inactive");
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => reconcileLearnerRetentionState(id, ended, ended)));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await n("select count(*) n from learner_journey_retention_state where learner_id = ?", id)).toBe(1);
  });

  it("racing purge runs delete once and advance the generation exactly once", async () => {
    const id = await learner("inactive");
    await reconcileLearnerRetentionState(id, ended, ended);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => purgeLearnerJourneyIfDue(id, due)));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const purged = results.filter((r) => r.status === "fulfilled" && (r.value as { purged: boolean }).purged);
    expect(purged).toHaveLength(1);
    expect(await n("select retention_generation n from learner_journey_retention_state where learner_id = ?", id)).toBe(2);
  });

  it("a learner who is active at purge time is never purged", async () => {
    const id = await learner("active");
    await reconcileLearnerRetentionState(id, ended, ended);
    const result = await purgeLearnerJourneyIfDue(id, due);
    expect(result.purged).toBe(false);
    expect(await n("select retention_generation n from learner_journey_retention_state where learner_id = ?", id)).toBe(1);
  });
});
