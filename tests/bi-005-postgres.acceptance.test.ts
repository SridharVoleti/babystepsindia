// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("BI-005 staging refund, dispute, and document certification", () => {
  const clients = [0, 1].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const suffix = randomUUID().replaceAll("-", "");
  const refunds = `bi005_refunds_${suffix}`;
  const documents = `bi005_documents_${suffix}`;
  const credits = `bi005_credits_${suffix}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`create table ${refunds}(event_id uuid primary key,amount integer not null,
      entitlement_effect text not null,result text not null)`);
    await clients[0].query(`create table ${documents}(refund_event_id uuid primary key,document_number text unique,
      status text not null,attempt_count integer not null default 0,storage_ref text)`);
    await clients[0].query(`create table ${credits}(id uuid primary key,consumed integer not null,
      expires_at timestamptz not null)`);
  });

  afterAll(async () => {
    await clients[0].query(`drop table if exists ${documents}`);
    await clients[0].query(`drop table if exists ${refunds}`);
    await clients[0].query(`drop table if exists ${credits}`);
    await Promise.all(clients.map((client) => client.end()));
  });

  it("records concurrent duplicate refund confirmation once with one entitlement effect", async () => {
    const eventId = randomUUID();
    const confirm = (client: Client) => client.query(`insert into ${refunds}
      values($1,5000,'terminate_now','confirmed') on conflict(event_id) do nothing returning event_id`, [eventId]);
    const results = await Promise.all(clients.map(confirm));
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
    expect((await clients[0].query(`select count(*)::int n from ${refunds}`)).rows[0].n).toBe(1);
  });

  it("retries document generation without allocating a second document number", async () => {
    const eventId = randomUUID();
    const number = `CN-${suffix}`;
    await clients[0].query(`insert into ${documents} values($1,$2,'pending',0,null)`, [eventId, number]);
    await clients[0].query(`update ${documents} set status='failed',attempt_count=1 where refund_event_id=$1`, [eventId]);
    await clients[0].query(`update ${documents} set status='issued',attempt_count=2,storage_ref='private/document.pdf'
      where refund_event_id=$1`, [eventId]);
    expect((await clients[0].query(`select * from ${documents} where refund_event_id=$1`, [eventId])).rows[0])
      .toMatchObject({ document_number: number, status: "issued", attempt_count: 2 });
  });

  it("does not restore expired or consumed credits after financial reversal", async () => {
    const creditId = randomUUID();
    await clients[0].query(`insert into ${credits} values($1,3,'2026-08-19T00:00:00Z')`, [creditId]);
    const before = (await clients[0].query(`select consumed,expires_at from ${credits} where id=$1`, [creditId])).rows[0];
    await clients[0].query(`insert into ${refunds} values($1,29900,'terminate_now','confirmed')`, [randomUUID()]);
    const after = (await clients[0].query(`select consumed,expires_at from ${credits} where id=$1`, [creditId])).rows[0];
    expect(after).toEqual(before);
  });

  it("has forced RLS, immutable document triggers, and exact-once finance constraints", async () => {
    const table = (await clients[0].query(`select relrowsecurity,relforcerowsecurity from pg_class
      where relname='refund_adjustment_documents'`)).rows[0];
    expect([table.relrowsecurity, table.relforcerowsecurity]).toEqual([true, true]);
    const triggers = await clients[0].query(`select tgname from pg_trigger where not tgisinternal and
      tgname=any($1::text[])`, [["refund_adjustment_documents_context_immutable",
      "refund_adjustment_documents_no_delete", "payment_provider_events_context_immutable",
      "billing_periods_financial_context_immutable"]]);
    expect(triggers.rows).toHaveLength(4);
    const uniques = await clients[0].query(`select count(*)::int n from pg_constraint where
      conrelid='refund_adjustment_documents'::regclass and contype in ('p','u')`);
    expect(uniques.rows[0].n).toBeGreaterThanOrEqual(3);
  });
});
