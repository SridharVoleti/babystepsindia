import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";

describe("BI-001 catalog database invariants", () => {
  beforeEach(() => useInMemoryDb());

  it("keeps published price versions immutable while allowing retirement", () => {
    const db = getDb();
    const product = db.prepare("select id from products limit 1").get() as { id: string };
    const price = db.prepare("select id,unit_amount from product_prices where product_id=? limit 1")
      .get(product.id) as { id: string; unit_amount: number };
    expect(() => db.prepare("update product_prices set unit_amount=unit_amount+1 where id=?").run(price.id))
      .toThrow(/product price version is immutable/);
    db.prepare("update product_prices set status='retired',effective_to=? where id=?")
      .run("2026-08-24T00:00:00.000Z", price.id);
    expect(db.prepare("select unit_amount,status from product_prices where id=?").get(price.id))
      .toEqual({ unit_amount: price.unit_amount, status: "retired" });
  });

  it("prevents catalog and price rebinding on an existing subscription", () => {
    const sql = getDb().prepare("select sql from sqlite_master where type='trigger' and name=?");
    expect((sql.get("subscriptions_catalog_snapshot_immutable") as { sql: string }).sql)
      .toContain("product_version");
    expect((sql.get("product_version_apps_no_delete") as { sql: string }).sql)
      .toContain("product version app mapping is immutable");
  });
});
