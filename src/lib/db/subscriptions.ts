import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { logAuditEvent } from "@/lib/db/audit";
import type { Entitlements, Subscription } from "@/lib/db/types";

const ACCESS_STATUSES = ["active", "cancelling", "past_due"];

// Mirrors REQ-08 §3.5 `fn_has_product_access`, aggregated for all products
// at once — this is what gets embedded as the JWT `entitlements` claim
// (§4.1) rather than queried live by product apps.
export function getEntitlementsForUser(userId: string): Entitlements {
  const db = getDb();

  const bundleRow = db
    .prepare(
      `select 1 from subscriptions
       where user_id = ? and type = 'bundle'
         and status in (${ACCESS_STATUSES.map(() => "?").join(",")})
         and current_period_end > datetime('now')
       limit 1`,
    )
    .get(userId, ...ACCESS_STATUSES);

  if (bundleRow) {
    return { bundle: true, products: [] };
  }

  const rows = db
    .prepare(
      `select p.slug as slug
       from subscriptions s
       join products p on p.id = s.product_id
       where s.user_id = ? and s.type = 'single'
         and s.status in (${ACCESS_STATUSES.map(() => "?").join(",")})
         and s.current_period_end > datetime('now')`,
    )
    .all(userId, ...ACCESS_STATUSES) as { slug: string }[];

  return { bundle: false, products: rows.map((r) => r.slug) };
}

export function findUserByEmailForGrant(email: string) {
  return getDb()
    .prepare("select id, email from users where email = ?")
    .get(email.toLowerCase()) as { id: string; email: string } | undefined;
}

function insertActiveSubscription(params: {
  userId: string;
  assignedLearnerId: string;
  type: "bundle" | "single";
  productId: string;
  currentPeriodEnd: string;
  changedBy: string;
  changeType: string;
  note: string | null;
}): Subscription {
  const db = getDb();
  const id = randomUUID();
  const binding = db.prepare(
    `select p.product_type from products p
     join learners l on l.id=? and l.owner_parent_id=?
     where p.id=?`,
  ).get(params.assignedLearnerId, params.userId, params.productId) as { product_type: string } | undefined;
  if (!binding || (params.type === "bundle") !== (binding.product_type === "bundle")) {
    throw new Error("INVALID_SUBSCRIPTION_ASSIGNMENT");
  }

  const insert = db.transaction(() => {
    db.prepare(
      `insert into subscriptions
         (id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,status,
          razorpay_subscription_id,current_period_start,current_period_end)
       select ?,?,?,?,?,?,p.version,'active',?,datetime('now'),? from products p where p.id=?`,
    ).run(
      id,
      params.userId,
      params.type,
      params.productId,
      params.userId,
      params.assignedLearnerId,
      `manual-${randomUUID()}`,
      params.currentPeriodEnd,
      params.productId,
    );

    logAuditEvent({
      subscriptionId: id,
      changedBy: params.changedBy,
      changeType: params.changeType,
      oldStatus: null,
      newStatus: "active",
      note: params.note,
    });
  });
  insert();

  return db.prepare("select * from subscriptions where id = ?").get(id) as Subscription;
}

// REQ-08 §7 — the manual "grant access" action for when payment succeeded
// but the (not-yet-built) webhook failed to record it.
export function createManualGrant(params: {
  userId: string;
  assignedLearnerId: string;
  type: "bundle" | "single";
  productId: string;
  currentPeriodEnd: string;
  adminEmail: string;
  note: string | null;
}): Subscription {
  return insertActiveSubscription({
    userId: params.userId,
    assignedLearnerId: params.assignedLearnerId,
    type: params.type,
    productId: params.productId,
    currentPeriodEnd: params.currentPeriodEnd,
    changedBy: `admin:${params.adminEmail}`,
    changeType: "manual_override",
    note: params.note,
  });
}

// No payment provider is wired up yet (REQ-08 §6) — this stands in for a
// real checkout so subscribe -> launch is testable end to end. Grants a
// fixed 30-day window per click; it's a placeholder, not a Razorpay
// subscription creation flow.
export function createSelfServeSubscription(params: {
  userId: string;
  userEmail: string;
  assignedLearnerId: string;
  productId: string;
  currentPeriodEnd: string;
}): Subscription {
  return insertActiveSubscription({
    userId: params.userId,
    assignedLearnerId: params.assignedLearnerId,
    type: "single",
    productId: params.productId,
    currentPeriodEnd: params.currentPeriodEnd,
    changedBy: `self:${params.userEmail}`,
    changeType: "created",
    note: "Self-serve subscribe (no payment provider wired up yet)",
  });
}

// REQ-08 §8 `v_active_subscribers_by_product` — a current snapshot, not
// date-ranged.
export function activeSubscribersByProduct(): {
  productSlug: string;
  activeSubscribers: number;
}[] {
  const rows = getDb()
    .prepare(
      `select coalesce(pr.slug, 'bundle') as productSlug, count(*) as activeSubscribers
       from subscriptions s
       left join products pr on pr.id = s.product_id
       where s.status in ('active','cancelling')
       group by 1
       order by activeSubscribers desc`,
    )
    .all() as { productSlug: string; activeSubscribers: number }[];

  return rows;
}

export function totalActiveSubscribers(): number {
  const row = getDb()
    .prepare(
      `select count(*) as n from subscriptions where status in ('active','cancelling')`,
    )
    .get() as { n: number };
  return row.n;
}

export function newSubscriptionsInRange(fromISO: string, toISO: string): number {
  const row = getDb()
    .prepare(
      `select count(*) as n from subscriptions
       where started_at >= ? and started_at < ?`,
    )
    .get(fromISO, toISO) as { n: number };
  return row.n;
}

const GRANULARITY_EXPR: Record<string, string> = {
  day: "strftime('%Y-%m-%d', %COL%)",
  week: "strftime('%Y-W%W', %COL%)",
  month: "strftime('%Y-%m', %COL%)",
  quarter:
    "strftime('%Y', %COL%) || '-Q' || ((cast(strftime('%m', %COL%) as integer) - 1) / 3 + 1)",
  year: "strftime('%Y', %COL%)",
};

export type Granularity = "day" | "week" | "month" | "quarter" | "year";

// REQ-08 §8 growth-rate view — new subscriptions per period per product.
export function growthByProduct(
  fromISO: string,
  toISO: string,
  granularity: Granularity,
): { period: string; productSlug: string; newSubscriptions: number }[] {
  const periodExpr = GRANULARITY_EXPR[granularity].replaceAll(
    "%COL%",
    "s.started_at",
  );

  return getDb()
    .prepare(
      `select ${periodExpr} as period,
              coalesce(pr.slug, 'bundle') as productSlug,
              count(*) as newSubscriptions
       from subscriptions s
       left join products pr on pr.id = s.product_id
       where s.started_at >= ? and s.started_at < ?
       group by 1, 2
       order by 1, 2`,
    )
    .all(fromISO, toISO) as {
    period: string;
    productSlug: string;
    newSubscriptions: number;
  }[];
}
