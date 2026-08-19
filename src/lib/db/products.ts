import { resolveDbClient } from "@/lib/db-client";
import type { ProductRow } from "@/lib/db/types";

export function listProducts(): Promise<ProductRow[]> {
  return resolveDbClient().all<ProductRow>(
    "select * from products where status != 'archived' order by name",
  );
}

export function findProductBySlug(slug: string): Promise<ProductRow | undefined> {
  return resolveDbClient().get<ProductRow>("select * from products where slug = ?", [slug]);
}
