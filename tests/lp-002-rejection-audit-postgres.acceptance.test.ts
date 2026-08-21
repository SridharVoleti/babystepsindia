// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createLearner } from "@/lib/learner-profile/postgres-service";
import { auditRejectedLearnerProfileMutation } from "@/lib/learner-profile/rejection-audit";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LP-002 rejected-mutation production audit", () => {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const parentId = randomUUID();
  let learnerId = "";

  beforeAll(async () => {
    await db.connect();
    await db.query("insert into auth.users(id,email,encrypted_password,aud,role,raw_user_meta_data) values($1,$2,'','authenticated','authenticated','{}')",
      [parentId, `lp002-audit-${parentId}@example.com`]);
    learnerId = (await createLearner(parentId, { displayName: "Audit Learner", dateOfBirth: "2018-02-10",
      idempotencyKey: randomUUID() }, "2026-08-21")).learner.id;
  });
  afterAll(async () => {
    await db.query("delete from learner_profile_update_requests where parent_user_id=$1", [parentId]);
    await db.query("delete from learner_creation_requests where parent_user_id=$1", [parentId]);
    await db.query("delete from account_events where parent_user_id=$1", [parentId]);
    await db.query("delete from learners where owner_parent_id=$1", [parentId]);
    await db.query("delete from auth.users where id=$1", [parentId]);
    await db.end();
  });

  it("persists an attributable, value-free rejection without changing the learner", async () => {
    const before = await db.query("select id,owner_parent_id,display_name,date_of_birth,version,created_at,updated_at from learners where id=$1", [learnerId]);
    await auditRejectedLearnerProfileMutation({ parentUserId: parentId, learnerId,
      protectedFieldCategory: "commercial_state" });
    const after = await db.query("select id,owner_parent_id,display_name,date_of_birth,version,created_at,updated_at from learners where id=$1", [learnerId]);
    expect(after.rows).toEqual(before.rows);
    const events = await db.query("select event_type,metadata from account_events where parent_user_id=$1 order by created_at", [parentId]);
    expect(events.rows.filter(row => row.event_type === "learner_profile_changed")).toHaveLength(0);
    expect(events.rows.at(-1)).toMatchObject({ event_type: "learner_profile_mutation_rejected", metadata: {
      learnerId, action: "parent.learner.manage", outcome: "rejected", errorCode: "FORBIDDEN_FIELD",
      protectedFieldCategory: "commercial_state",
    } });
    expect(JSON.stringify(events.rows.at(-1))).not.toContain("raw-sensitive-attempt");
  });
});
