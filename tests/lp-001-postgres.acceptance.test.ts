// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createLearner, getOwnedLearner, listOwnedLearners } from "@/lib/learner-profile/postgres-service";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LP-001 staging Supabase/Postgres acceptance", () => {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const parentId = randomUUID();
  let learnerId = "";

  beforeAll(async () => {
    await db.connect();
    await db.query("insert into auth.users(id,email,encrypted_password,aud,role,raw_user_meta_data) values($1,$2,'','authenticated','authenticated','{}')",
      [parentId, `lp001-${Date.now()}@example.com`]);
    await db.query("update profiles set onboarding_status='learner_pending' where id=$1", [parentId]);
  });
  afterAll(async () => {
    await db.query("delete from learner_creation_requests where parent_user_id=$1", [parentId]);
    await db.query("delete from learners where owner_parent_id=$1", [parentId]);
    await db.query("delete from auth.users where id=$1", [parentId]);
    await db.end();
  });

  it("creates once, replays safely, completes onboarding, and creates no commercial state", async () => {
    const input = { displayName: "Asha", dateOfBirth: "1980-02-29", idempotencyKey: randomUUID() };
    const first = await createLearner(parentId, input, "2026-08-21"); learnerId = first.learner.id;
    const replay = await createLearner(parentId, input, "2026-08-21");
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true);
    expect(replay.learner.id).toBe(learnerId);
    expect(await listOwnedLearners(parentId, "2026-08-21")).toHaveLength(1);
    expect((await getOwnedLearner(parentId, learnerId, "2026-08-21")).dateOfBirth).toBe("1980-02-29");
    const state = await db.query(`select p.onboarding_status,
      (select count(*)::int from subscriptions where user_id=$1) subscriptions,
      (select count(*)::int from learner_sessions where parent_user_id=$1) sessions
      from profiles p where p.id=$1`, [parentId]);
    expect(state.rows[0]).toMatchObject({ onboarding_status: "complete", subscriptions: 0, sessions: 0 });
  });
});
