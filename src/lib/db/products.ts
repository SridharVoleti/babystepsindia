import { getDb } from "@/lib/db/client";
import type { ProductRow } from "@/lib/db/types";

export function listProducts(): ProductRow[] {
  return getDb()
    .prepare("select * from products where status != 'archived' order by name")
    .all() as ProductRow[];
}

export function findProductBySlug(slug: string): ProductRow | undefined {
  return getDb().prepare("select * from products where slug = ?").get(slug) as
    | ProductRow
    | undefined;
}
