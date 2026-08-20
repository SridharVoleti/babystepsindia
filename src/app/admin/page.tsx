import type { Metadata } from "next";
import { parseDateRange, previousRange } from "@/lib/admin/date-range";
import { pivotByPeriodAndProduct } from "@/lib/admin/pivot";
import { listProducts } from "@/lib/db/products";
import { revenueByProduct, totalRevenueInRange } from "@/lib/db/payments";
import {
  activeSubscribersByProduct,
  growthByProduct,
  newSubscriptionsInRange,
  totalActiveSubscribers,
} from "@/lib/db/subscriptions";
import { formatCompactINR, formatCompactNumber, formatINR } from "@/lib/format";
import { DateRangeForm } from "@/components/admin/date-range-form";
import { StatTile } from "@/components/admin/stat-tile";
import { BarRow } from "@/components/admin/bar-row";
import { PivotTable } from "@/components/admin/pivot-table";

export const metadata: Metadata = { title: "Admin overview — Baby Steps" };

function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; granularity?: string };
}) {
  const range = parseDateRange(searchParams);
  const prev = previousRange(range);

  const products = await listProducts();
  const productOrder = ["bundle", ...products.map((p) => p.slug)];
  const productLabels: Record<string, string> = { bundle: "Bundle" };
  for (const p of products) productLabels[p.slug] = p.name;

  const revenueRows = await revenueByProduct(range.fromISO, range.toISO, range.granularity);
  const revenuePivot = pivotByPeriodAndProduct(revenueRows, "revenueInr", productOrder);
  const maxRevenue = Math.max(1, ...Object.values(revenuePivot.totalsByProduct));

  const growthRows = await growthByProduct(range.fromISO, range.toISO, range.granularity);
  const growthPivot = pivotByPeriodAndProduct(
    growthRows,
    "newSubscriptions",
    productOrder,
  );

  const activeSubs = await activeSubscribersByProduct();
  const maxActiveSubs = Math.max(1, ...activeSubs.map((r) => r.activeSubscribers));

  const totalRevenue = await totalRevenueInRange(range.fromISO, range.toISO);
  const prevTotalRevenue = await totalRevenueInRange(prev.fromISO, prev.toISO);

  const newSubs = await newSubscriptionsInRange(range.fromISO, range.toISO);
  const prevNewSubs = await newSubscriptionsInRange(prev.fromISO, prev.toISO);

  const activeNow = await totalActiveSubscribers();

  const revenueBySlug = Object.entries(revenuePivot.totalsByProduct).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Overview</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Revenue and subscriber activity across all products (REQ-08 §8).
        </p>
      </div>

      <DateRangeForm
        fromDate={range.fromDate}
        toDate={range.toDate}
        granularity={range.granularity}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Revenue in range"
          value={formatCompactINR(totalRevenue)}
          deltaPercent={deltaPercent(totalRevenue, prevTotalRevenue)}
        />
        <StatTile
          label="New subscriptions in range"
          value={formatCompactNumber(newSubs)}
          deltaPercent={deltaPercent(newSubs, prevNewSubs)}
        />
        <StatTile
          label="Active subscribers now"
          value={formatCompactNumber(activeNow)}
        />
      </div>

      <section className="card p-6">
        <h2 className="text-lg font-semibold text-chakra-900">Revenue by product</h2>
        <p className="mt-1 text-sm text-chakra-500">Total in range, by product.</p>

        <div className="mt-5 space-y-3">
          {revenueBySlug.length === 0 && (
            <p className="text-sm text-chakra-400">
              No payments recorded in this range yet.
            </p>
          )}
          {revenueBySlug.map(([slug, total]) => (
            <BarRow
              key={slug}
              label={productLabels[slug] ?? slug}
              value={total}
              displayValue={formatINR(total)}
              maxValue={maxRevenue}
            />
          ))}
        </div>

        <h3 className="mt-8 text-sm font-semibold text-chakra-700">
          By {range.granularity}
        </h3>
        <div className="mt-3">
          <PivotTable
            pivot={revenuePivot}
            productLabels={productLabels}
            formatValue={formatINR}
          />
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold text-chakra-900">
          Active subscribers by product
        </h2>
        <p className="mt-1 text-sm text-chakra-500">
          Current snapshot (active + cancelling).
        </p>

        <div className="mt-5 space-y-3">
          {activeSubs.length === 0 && (
            <p className="text-sm text-chakra-400">No active subscriptions yet.</p>
          )}
          {activeSubs.map((row) => (
            <BarRow
              key={row.productSlug}
              label={productLabels[row.productSlug] ?? row.productSlug}
              value={row.activeSubscribers}
              displayValue={formatCompactNumber(row.activeSubscribers)}
              maxValue={maxActiveSubs}
            />
          ))}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold text-chakra-900">Growth</h2>
        <p className="mt-1 text-sm text-chakra-500">
          New subscriptions per {range.granularity}, by product — separates
          fast-moving products from slow ones.
        </p>
        <div className="mt-5">
          <PivotTable
            pivot={growthPivot}
            productLabels={productLabels}
            formatValue={formatCompactNumber}
          />
        </div>
      </section>
    </div>
  );
}
