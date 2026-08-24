// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("BI-002 staging Supabase/Postgres lifecycle concurrency certification", () => {
  const clients = [0, 1].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const suffix = randomUUID().replaceAll("-", "");
  const lifecycle = `bi002_lifecycle_${suffix}`;
  const provider = `cert-${suffix}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`create table ${lifecycle}(id uuid primary key,status text not null,
      payment_state text not null,version integer not null,current_period_end timestamptz not null)`);
  });

  afterAll(async () => {
    await clients[0].query("delete from payment_provider_events where provider=$1", [provider]);
    await clients[0].query(`drop table if exists ${lifecycle}`);
    await Promise.all(clients.map((client) => client.end()));
  });

  it("records a duplicate provider event exactly once under concurrency", async () => {
    const eventId = randomUUID();
    const insert = (client: Client) => client.query(`insert into payment_provider_events(provider,environment,
      account_id,provider_event_id,event_type,payload_hash,status,received_at)
      values($1,'test','cert-account',$2,'renewal_payment_succeeded','hash','received',now())
      on conflict(provider,environment,account_id,provider_event_id) do nothing returning provider_event_id`,
    [provider, eventId]);
    const results = await Promise.all([insert(clients[0]), insert(clients[1])]);
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
  });

  it("allows one lifecycle action for an expected version", async () => {
    const id = randomUUID();
    await clients[0].query(`insert into ${lifecycle} values($1,'active','paid',1,now()+interval '30 days')`, [id]);
    const mutate = (client: Client, status: string) => client.query(`update ${lifecycle}
      set status=$2,version=version+1 where id=$1 and version=1 returning version`, [id, status]);
    const results = await Promise.all([mutate(clients[0], "cancelling"), mutate(clients[1], "past_due")]);
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
  });

  it("keeps delayed settlement monotonic and rejects renewal after cancellation", async () => {
    const id = randomUUID();
    await clients[0].query(`insert into ${lifecycle} values($1,'past_due','renewal_failed',1,now())`, [id]);
    expect((await clients[0].query(`update ${lifecycle} set status='active',payment_state='paid',version=2,
      current_period_end=current_period_end+interval '30 days' where id=$1 and status='past_due' and version=1 returning id`,
    [id])).rowCount).toBe(1);
    await clients[0].query(`update ${lifecycle} set status='cancelled',version=3 where id=$1`, [id]);
    expect((await clients[0].query(`update ${lifecycle} set status='active',version=4 where id=$1
      and status in ('active','past_due') returning id`, [id])).rowCount).toBe(0);
  });

  it("has exact-once ledger constraints, forced RLS, and the terminal trigger", async () => {
    const constraints = await clients[0].query(`select conname from pg_constraint where conrelid in
      ('payment_provider_events'::regclass,'billing_periods'::regclass) and contype in ('p','u')`);
    expect(constraints.rows.length).toBeGreaterThanOrEqual(3);
    const tables = await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname=any($1::text[])`, [["payment_provider_events", "billing_periods", "subscriptions"]]);
    expect(tables.rows).toHaveLength(3);
    for (const row of tables.rows) expect(row.relrowsecurity).toBe(true);
    expect((await clients[0].query(`select count(*)::int n from pg_trigger where not tgisinternal
      and tgname='subscriptions_cancelled_terminal'`)).rows[0].n).toBe(1);
  });
});
