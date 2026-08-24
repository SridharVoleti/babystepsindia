// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("BI-004 staging renewal recovery and payment failure certification", () => {
  const clients = [0, 1].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const suffix = randomUUID().replaceAll("-", "");
  const subscriptions = `bi004_subscriptions_${suffix}`;
  const receipts = `bi004_receipts_${suffix}`;
  const periods = `bi004_periods_${suffix}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`create table ${subscriptions}(id uuid primary key,payment_state text not null,
      current_period_end timestamptz not null,grace_started_at timestamptz,grace_ends_at timestamptz,
      access_until timestamptz not null,retry_count integer not null default 0,version integer not null)`);
    await clients[0].query(`create table ${receipts}(event_id uuid primary key,payload_hash text not null)`);
    await clients[0].query(`create table ${periods}(subscription_id uuid not null,period_start timestamptz not null,
      period_end timestamptz not null,payment_ref text not null unique,
      unique(subscription_id,period_start,period_end))`);
  });

  afterAll(async () => {
    await clients[0].query(`drop table if exists ${periods}`);
    await clients[0].query(`drop table if exists ${receipts}`);
    await clients[0].query(`drop table if exists ${subscriptions}`);
    await Promise.all(clients.map((client) => client.end()));
  });

  async function seed(periodEnd = "2026-09-10T10:00:00.000Z") {
    const id = randomUUID();
    await clients[0].query(`insert into ${subscriptions}
      (id,payment_state,current_period_end,access_until,version) values($1,'paid',$2,$2,1)`, [id, periodEnd]);
    return id;
  }

  async function recover(client: Client, id: string, eventId: string, settledAt: string) {
    await client.query("begin");
    try {
      const receipt = await client.query(`insert into ${receipts} values($1,'same-payload')
        on conflict(event_id) do nothing returning event_id`, [eventId]);
      if (!receipt.rowCount) { await client.query("rollback"); return "duplicate"; }
      const updated = await client.query(`update ${subscriptions} set payment_state='paid',
        current_period_end=current_period_end+interval '1 month',access_until=current_period_end+interval '1 month',
        grace_started_at=null,grace_ends_at=null,version=version+1
        where id=$1 and payment_state in ('past_due_grace','inactive_nonpayment')
        and $2::timestamptz<=grace_ends_at returning current_period_end-interval '1 month' period_start,
        current_period_end period_end`, [id, settledAt]);
      if (!updated.rowCount) { await client.query("rollback"); return "expired"; }
      await client.query(`insert into ${periods} values($1,$2,$3,$4)`,
        [id, updated.rows[0].period_start, updated.rows[0].period_end, `payment-${eventId}`]);
      await client.query("commit");
      return "recovered";
    } catch (error) { await client.query("rollback"); throw error; }
  }

  it("enters one fixed grace window on first failure and retries never extend access", async () => {
    const id = await seed();
    const first = await clients[0].query(`update ${subscriptions} set payment_state='past_due_grace',
      grace_started_at=current_period_end,grace_ends_at=current_period_end+interval '7 days',
      access_until=current_period_end+interval '7 days',retry_count=1,version=2
      where id=$1 and payment_state='paid' and version=1 returning *`, [id]);
    expect(first.rowCount).toBe(1);
    const retry = await clients[0].query(`update ${subscriptions} set retry_count=retry_count+1,version=version+1
      where id=$1 and payment_state='past_due_grace' returning grace_ends_at,access_until,retry_count`, [id]);
    expect(retry.rows[0].retry_count).toBe(2);
    expect(retry.rows[0].grace_ends_at.toISOString()).toBe("2026-09-17T10:00:00.000Z");
    expect(retry.rows[0].access_until.toISOString()).toBe("2026-09-17T10:00:00.000Z");
  });

  it("applies concurrent duplicate recovery exactly once", async () => {
    const id = await seed();
    await clients[0].query(`update ${subscriptions} set payment_state='past_due_grace',
      grace_started_at=current_period_end,grace_ends_at=current_period_end+interval '7 days',
      access_until=current_period_end+interval '7 days',version=2 where id=$1`, [id]);
    const eventId = randomUUID();
    const results = await Promise.all(clients.map((client) => recover(client, id, eventId,
      "2026-09-14T10:00:00.000Z")));
    expect(results.sort()).toEqual(["duplicate", "recovered"]);
    expect((await clients[0].query(`select count(*)::int n from ${periods} where subscription_id=$1`, [id]))
      .rows[0].n).toBe(1);
  });

  it("accepts delayed delivery settled within grace, but rejects settlement after the deadline", async () => {
    const timely = await seed();
    const late = await seed("2026-10-10T10:00:00.000Z");
    for (const id of [timely, late]) await clients[0].query(`update ${subscriptions}
      set payment_state='inactive_nonpayment',grace_started_at=current_period_end,
      grace_ends_at=current_period_end+interval '7 days',access_until=current_period_end+interval '7 days',version=3
      where id=$1`, [id]);
    expect(await recover(clients[0], timely, randomUUID(), "2026-09-17T09:59:59.000Z")).toBe("recovered");
    expect(await recover(clients[0], late, randomUUID(), "2026-10-17T10:00:01.000Z")).toBe("expired");
    expect((await clients[0].query(`select payment_state from ${subscriptions} where id=$1`, [late]))
      .rows[0].payment_state).toBe("inactive_nonpayment");
  });

  it("has staging columns, exact-once constraints, immutable evidence triggers, and forced RLS", async () => {
    const columns = await clients[0].query(`select column_name from information_schema.columns
      where table_schema='public' and table_name='subscriptions' and column_name=any($1::text[])`,
    [["payment_state", "grace_started_at", "grace_ends_at", "nonpayment_ended_at", "last_recovery_attempt_at"]]);
    expect(columns.rows).toHaveLength(5);
    const tables = await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname=any($1::text[])`, [["subscriptions", "payment_provider_events", "billing_periods"]]);
    expect(tables.rows).toHaveLength(3);
    for (const row of tables.rows) expect([row.relrowsecurity, row.relforcerowsecurity]).toEqual([true, true]);
    const triggers = await clients[0].query(`select tgname from pg_trigger where not tgisinternal
      and tgname=any($1::text[])`, [["payment_provider_events_context_immutable",
      "payment_provider_events_no_delete", "billing_periods_financial_context_immutable",
      "billing_periods_no_delete", "subscriptions_cancelled_terminal"]]);
    expect(triggers.rows).toHaveLength(5);
  });
});
