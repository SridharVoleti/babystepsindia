// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("BI-001 staging Supabase/Postgres catalog certification", () => {
  const clients = [0, 1].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const productId = randomUUID();
  const slug = `bi001-${randomUUID()}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`insert into products(id,slug,name,subdomain,razorpay_plan_id,price_inr,status,product_type,version)
      values($1,$2,'Certified plan','cert.example','cert-plan',299,'active','individual_app',1)`, [productId, slug]);
    await clients[0].query(`insert into product_prices(id,product_id,currency,billing_interval,interval_count,
      unit_amount,pricing_rule_version,supports_non_renewing,status,effective_from,version)
      values($1,$2,'INR','month',1,29900,'cert-v1',true,'active',now(),1)`, [randomUUID(), productId]);
  });

  afterAll(async () => {
    await clients[0].query("delete from product_prices where product_id=$1", [productId]);
    await clients[0].query("delete from products where id=$1", [productId]);
    await Promise.all(clients.map((client) => client.end()));
  });

  it("admits only one concurrent admin edit from an expected catalog version", async () => {
    const edit = (client: Client, name: string) => client.query(`update products set name=$2,version=2
      where id=$1 and version=1 returning version`, [productId, name]);
    const results = await Promise.all([edit(clients[0], "Plan A"), edit(clients[1], "Plan B")]);
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
    expect((await clients[0].query("select count(*)::int n,max(version)::int version from products where id=$1",
      [productId])).rows[0]).toEqual({ n: 1, version: 2 });
  });

  it("keeps the historical price amount immutable and supports retirement", async () => {
    await expect(clients[0].query("update product_prices set unit_amount=39900 where product_id=$1", [productId]))
      .rejects.toThrow(/product price version is immutable/);
    await clients[0].query("update product_prices set status='retired',effective_to=now() where product_id=$1", [productId]);
    expect((await clients[0].query("select unit_amount::int,status from product_prices where product_id=$1",
      [productId])).rows[0]).toEqual({ unit_amount: 29900, status: "retired" });
  });

  it("makes an archived product ineligible for new checkout snapshots", async () => {
    await clients[0].query("update products set status='archived' where id=$1", [productId]);
    expect((await clients[0].query("select id from products where id=$1 and status='active'", [productId])).rowCount).toBe(0);
  });

  it("forces RLS and installs immutable subscription/catalog boundaries", async () => {
    const rls = await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname=any($1::text[])`, [["products", "product_prices", "checkout_intents", "subscriptions"]]);
    expect(rls.rows).toHaveLength(4);
    for (const row of rls.rows) expect(row.relrowsecurity).toBe(true);
    const triggers = await clients[0].query(`select tgname from pg_trigger where not tgisinternal and
      tgname=any($1::text[])`, [["product_prices_version_immutable", "subscriptions_catalog_snapshot_immutable",
      "product_version_apps_no_update_delete"]]);
    expect(triggers.rows.map((row) => row.tgname).sort()).toEqual([
      "product_prices_version_immutable", "product_version_apps_no_update_delete",
      "subscriptions_catalog_snapshot_immutable",
    ]);
  });
});
