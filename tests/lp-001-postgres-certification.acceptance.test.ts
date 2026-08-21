// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createLearner, listOwnedLearners } from "@/lib/learner-profile/postgres-service";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LP-001 Postgres concurrency, rollback, and RLS certification", () => {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const parents: Array<{ id: string; email: string; password: string; token?: string }> = [0, 1].map(index => ({
    id: randomUUID(), email: `lp001-cert-${index}-${Date.now()}@gmail.com`, password: "Valid!Pass12345",
  }));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const headers = (key: string, token = key) => ({ apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  beforeAll(async () => {
    await db.connect();
    for (const parent of parents) {
      const created = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: headers(serviceKey),
        body: JSON.stringify({ id: parent.id, email: parent.email, password: parent.password, email_confirm: true }) });
      if (!created.ok) throw new Error(await created.text());
      await db.query("update profiles set onboarding_status='learner_pending' where id=$1", [parent.id]);
      const signed = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: headers(anonKey),
        body: JSON.stringify({ email: parent.email, password: parent.password }) });
      const session = await signed.json(); if (!signed.ok) throw new Error(JSON.stringify(session)); parent.token = session.access_token;
    }
  });
  afterAll(async () => {
    await db.query("drop trigger if exists ia004_lp001_rollback on account_events");
    await db.query("drop function if exists ia004_lp001_rollback() cascade");
    for (const parent of parents) {
      await db.query("delete from learner_creation_requests where parent_user_id=$1", [parent.id]);
      await db.query("delete from learners where owner_parent_id=$1", [parent.id]);
      await fetch(`${url}/auth/v1/admin/users/${parent.id}`, { method: "DELETE", headers: headers(serviceKey) });
    }
    await db.end();
  });

  it("passes the production certification matrix", async () => {
    const [first, second] = parents, asOf = "2026-08-21", replayKey = randomUUID();
    const replayAttempts = await Promise.all([
      createLearner(first.id, { displayName: "Asha", dateOfBirth: "2018-01-01", idempotencyKey: replayKey }, asOf),
      createLearner(first.id, { displayName: "Asha", dateOfBirth: "2018-01-01", idempotencyKey: replayKey }, asOf),
    ]);
    expect(new Set(replayAttempts.map(item => item.learner.id)).size).toBe(1);

    const sameName = await Promise.allSettled([
      createLearner(first.id, { displayName: "Ravi Rao", dateOfBirth: "2017-01-01", idempotencyKey: randomUUID() }, asOf),
      createLearner(first.id, { displayName: "  RAVI   RAO ", dateOfBirth: "2016-01-01", idempotencyKey: randomUUID() }, asOf),
    ]);
    expect(sameName.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(sameName.filter(item => item.status === "rejected")).toHaveLength(1);

    const own = await fetch(`${url}/rest/v1/learners?select=id&owner_parent_id=eq.${first.id}`, { headers: headers(anonKey, first.token) });
    const foreign = await fetch(`${url}/rest/v1/learners?select=id&owner_parent_id=eq.${first.id}`, { headers: headers(anonKey, second.token) });
    const forbiddenWrite = await fetch(`${url}/rest/v1/learners`, { method: "POST", headers: headers(anonKey, second.token),
      body: JSON.stringify({ owner_parent_id: first.id, display_name: "Injected", normalized_display_name: "injected",
        date_of_birth: "2018-01-01", locale: "en-IN", timezone: "Asia/Kolkata" }) });
    expect((await own.json()).length).toBeGreaterThan(0); expect(await foreign.json()).toEqual([]); expect(forbiddenWrite.ok).toBe(false);

    await db.query(`create function ia004_lp001_rollback() returns trigger language plpgsql as $$ begin
      if new.parent_user_id='${second.id}'::uuid then raise exception 'forced audit failure'; end if; return new; end $$`);
    await db.query("create trigger ia004_lp001_rollback before insert on account_events for each row execute function ia004_lp001_rollback()");
    await expect(createLearner(second.id, { displayName: "Rollback", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, asOf)).rejects.toThrow("forced audit failure");
    const rolledBack = await db.query(`select p.onboarding_status,
      (select count(*)::int from learners where owner_parent_id=$1) learners,
      (select count(*)::int from learner_creation_requests where parent_user_id=$1) requests from profiles p where id=$1`, [second.id]);
    expect(rolledBack.rows[0]).toMatchObject({ onboarding_status: "learner_pending", learners: 0, requests: 0 });
    await db.query("drop trigger ia004_lp001_rollback on account_events"); await db.query("drop function ia004_lp001_rollback()");

    await db.query("update profiles set account_status='deleted' where id=$1", [second.id]);
    await expect(createLearner(second.id, { displayName: "Denied", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, asOf)).rejects.toMatchObject({ code: "ACCOUNT_DELETED" });
    await expect(listOwnedLearners(second.id, asOf)).rejects.toMatchObject({ code: "ACCOUNT_DELETED" });

    const sideEffects = await db.query(`select
      (select count(*)::int from subscriptions where user_id=$1) subscriptions,
      (select count(*)::int from learner_sessions where parent_user_id=$1) sessions,
      (select count(*)::int from learner_app_progress lp join learners l on l.id=lp.learner_id where l.owner_parent_id=$1) progress`, [first.id]);
    expect(sideEffects.rows[0]).toEqual({ subscriptions: 0, sessions: 0, progress: 0 });
  });
});
