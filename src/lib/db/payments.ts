import { resolveDbClient } from "@/lib/db-client";
import { granularityExpr, type Granularity } from "@/lib/db/granularity";

export type RevenueRow = {
  period: string;
  productSlug: string;
  revenueInr: number;
  paymentCount: number;
};

// REQ-08 §8 `v_daily_revenue_by_product`, parameterized by range + granularity.
export async function revenueByProduct(
  fromISO: string,
  toISO: string,
  granularity: Granularity,
): Promise<RevenueRow[]> {
  const periodExpr = granularityExpr(granularity, "p.paid_at");

  return resolveDbClient().all<RevenueRow>(
    `select ${periodExpr} as period,
            coalesce(pr.slug, 'bundle') as productSlug,
            sum(p.amount_inr) as revenueInr,
            count(*) as paymentCount
     from payments p
     join subscriptions s on s.id = p.subscription_id
     left join products pr on pr.id = s.product_id
     where p.paid_at >= ? and p.paid_at < ?
     group by 1, 2
     order by 1, 2`,
    [fromISO, toISO],
  );
}

export async function totalRevenueInRange(fromISO: string, toISO: string): Promise<number> {
  const row = await resolveDbClient().get<{ total: number }>(
    `select coalesce(sum(amount_inr), 0) as total
     from payments where paid_at >= ? and paid_at < ?`,
    [fromISO, toISO],
  );
  return row!.total;
}
