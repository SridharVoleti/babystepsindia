// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createLearner, getOwnedLearner, updateLearner } from "@/lib/learner-profile/postgres-service";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LP-002 staging Supabase/Postgres acceptance", () => {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const parents = [randomUUID(), randomUUID()];
  const learners: string[] = [];

  beforeAll(async () => {
    await db.connect();
    for (const id of parents) {
      await db.query("insert into auth.users(id,email,encrypted_password,aud,role,raw_user_meta_data) values($1,$2,'','authenticated','authenticated','{}')",
        [id, `lp002-${id}@example.com`]);
    }
  });
  afterAll(async () => {
    await db.query("delete from learner_profile_update_requests where parent_user_id=any($1::uuid[])", [parents]);
    await db.query("delete from learner_creation_requests where parent_user_id=any($1::uuid[])", [parents]);
    await db.query("delete from account_events where parent_user_id=any($1::uuid[])", [parents]);
    await db.query("delete from learners where owner_parent_id=any($1::uuid[])", [parents]);
    await db.query("delete from auth.users where id=any($1::uuid[])", [parents]);
    await db.end();
  });

  it("serializes correction replay and preserves immutable state", async () => {
    const made = await createLearner(parents[0], { displayName: "Asha", dateOfBirth: "2018-02-20", idempotencyKey: randomUUID() }, "2026-08-21");
    learners.push(made.learner.id);
    const key = randomUUID();
    const input = { displayName: "Aasha", expectedVersion: 1, idempotencyKey: key };
    const [a, b] = await Promise.all([
      updateLearner(parents[0], made.learner.id, input, "2026-08-21"),
      updateLearner(parents[0], made.learner.id, input, "2026-08-21"),
    ]);
    expect(a).toEqual(b);
    expect(a.learner).toMatchObject({ id: made.learner.id, ownerParentId: parents[0], version: 2, createdAt: made.learner.createdAt });
    await expect(updateLearner(parents[0], made.learner.id,
      { displayName: "Stale", expectedVersion: 1, idempotencyKey: randomUUID() }, "2026-08-21"))
      .rejects.toMatchObject({ code: "LEARNER_VERSION_CONFLICT" });
    expect((await getOwnedLearner(parents[0], made.learner.id, "2026-08-21")).displayName).toBe("Aasha");
  });

  it("allows one concurrent duplicate-name winner and emits no event for a no-op", async () => {
    const x = await createLearner(parents[0], { displayName: "Kiran", dateOfBirth: "2017-01-01", idempotencyKey: randomUUID() }, "2026-08-21");
    const y = await createLearner(parents[0], { displayName: "Meera", dateOfBirth: "2017-01-01", idempotencyKey: randomUUID() }, "2026-08-21");
    learners.push(x.learner.id, y.learner.id);
    const outcomes = await Promise.allSettled([
      updateLearner(parents[0], x.learner.id, { displayName: "Tara", expectedVersion: 1, idempotencyKey: randomUUID() }, "2026-08-21"),
      updateLearner(parents[0], y.learner.id, { displayName: " tara ", expectedVersion: 1, idempotencyKey: randomUUID() }, "2026-08-21"),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const before = await db.query("select version,(select count(*)::int from account_events where parent_user_id=$1 and event_type='learner_profile_changed') events from learners where id=$2", [parents[0], learners[0]]);
    const noOp = await updateLearner(parents[0], learners[0], { displayName: " Aasha ", expectedVersion: 2, idempotencyKey: randomUUID() }, "2026-08-21");
    const after = await db.query("select version,(select count(*)::int from account_events where parent_user_id=$1 and event_type='learner_profile_changed') events from learners where id=$2", [parents[0], learners[0]]);
    expect(noOp.noOp).toBe(true);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("hides cross-parent learners in the service and denies browser-role writes through RLS", async () => {
    await expect(updateLearner(parents[1], learners[0],
      { displayName: "Intrusion", expectedVersion: 2, idempotencyKey: randomUUID() }, "2026-08-21"))
      .rejects.toMatchObject({ code: "LEARNER_NOT_FOUND" });
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [parents[1]]);
      const denied = await db.query("update learners set display_name='Intrusion' where id=$1 returning id", [learners[0]]);
      expect(denied.rowCount).toBe(0);
    } finally { await db.query("rollback"); }
  });
});
