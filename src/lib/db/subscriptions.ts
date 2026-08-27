import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { logAuditEvent } from "@/lib/db/audit";
import { granularityExpr, type Granularity } from "@/lib/db/granularity";
import type { Entitlements, Subscription } from "@/lib/db/types";

export type { Granularity };

const ACCESS_STATUSES = ["active", "cancelling", "past_due"];

// Mirrors REQ-08 §3.5 `fn_has_product_access`, aggregated for all products
// at once — this is what gets embedded as the JWT `entitlements` claim
// (§4.1) rather than queried live by product apps.
export async function getEntitlementsForUser(userId: string): Promise<Entitlements> {
  const db = resolveDbClient();
  const nowIso = new Date().toISOString();

  const bundleRow = await db.get(
    `select 1 from subscriptions
     where user_id = ? and type = 'bundle'
       and status in (${ACCESS_STATUSES.map(() => "?").join(",")})
       and current_period_end > ?
     limit 1`,
    [userId, ...ACCESS_STATUSES, nowIso],
  );

  if (bundleRow) {
    return { bundle: true, products: [] };
  }

  const rows = await db.all<{ slug: string }>(
    `select p.slug as slug
     from subscriptions s
     join products p on p.id = s.product_id
     where s.user_id = ? and s.type = 'single'
       and s.status in (${ACCESS_STATUSES.map(() => "?").join(",")})
       and s.current_period_end > ?`,
    [userId, ...ACCESS_STATUSES, nowIso],
  );

  return { bundle: false, products: rows.map((r) => r.slug) };
}

export async function findUserByEmailForGrant(email: string) {
  return resolveDbClient().get<{ id: string; email: string }>(
    "select id, email from users where email = ?", [email.toLowerCase()]);
}

async function insertActiveSubscription(params: {
  userId: string;
  assignedLearnerId: string;
  type: "bundle" | "single";
  productId: string;
  currentPeriodEnd: string;
  changedBy: string;
  changeType: string;
  note: string | null;
}): Promise<Subscription> {
  const id = randomUUID();
  const binding = await resolveDbClient().get<{ product_type: string }>(
    `select p.product_type from products p
     join learners l on l.id=? and l.owner_parent_id=?
     where p.id=?`,
    [params.assignedLearnerId, params.userId, params.productId],
  );
  if (!binding || (params.type === "bundle") !== (binding.product_type === "bundle")) {
    throw new Error("INVALID_SUBSCRIPTION_ASSIGNMENT");
  }

  await resolveDbClient().transaction(async (db: DbClient) => {
    await db.run(
      `insert into subscriptions
         (id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,status,
          razorpay_subscription_id,current_period_start,current_period_end)
       select ?,?,?,?,?,?,p.version,'active',?,?,? from products p where p.id=?`,
      [
        id,
        params.userId,
        params.type,
        params.productId,
        params.userId,
        params.assignedLearnerId,
        `manual-${randomUUID()}`,
        new Date().toISOString(),
        params.currentPeriodEnd,
        params.productId,
      ],
    );

    await logAuditEvent({
      subscriptionId: id,
      changedBy: params.changedBy,
      changeType: params.changeType,
      oldStatus: null,
      newStatus: "active",
      note: params.note,
    });
  });

  return (await resolveDbClient().get<Subscription>("select * from subscriptions where id = ?", [id]))!;
}

// REQ-08 §7 — the manual "grant access" action for when payment succeeded
// but the (not-yet-built) webhook failed to record it.
export async function createManualGrant(params: {
  userId: string;
  assignedLearnerId: string;
  type: "bundle" | "single";
  productId: string;
  currentPeriodEnd: string;
  adminEmail: string;
  note: string | null;
}): Promise<Subscription> {
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
export async function createSelfServeSubscription(params: {
  userId: string;
  userEmail: string;
  assignedLearnerId: string;
  productId: string;
  currentPeriodEnd: string;
}): Promise<Subscription> {
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
export async function activeSubscribersByProduct(): Promise<{
  productSlug: string;
  activeSubscribers: number;
}[]> {
  return resolveDbClient().all<{ productSlug: string; activeSubscribers: number }>(
    `select coalesce(pr.slug, 'bundle') as productSlug, count(*) as activeSubscribers
     from subscriptions s
     left join products pr on pr.id = s.product_id
     where s.status in ('active','cancelling')
     group by 1
     order by activeSubscribers desc`,
  );
}

export async function totalActiveSubscribers(): Promise<number> {
  const row = await resolveDbClient().get<{ n: number }>(
    `select count(*) as n from subscriptions where status in ('active','cancelling')`,
  );
  return row!.n;
}

export async function newSubscriptionsInRange(fromISO: string, toISO: string): Promise<number> {
  const row = await resolveDbClient().get<{ n: number }>(
    `select count(*) as n from subscriptions
     where started_at >= ? and started_at < ?`,
    [fromISO, toISO],
  );
  return row!.n;
}

// REQ-08 §8 growth-rate view — new subscriptions per period per product.
export async function growthByProduct(
  fromISO: string,
  toISO: string,
  granularity: Granularity,
): Promise<{ period: string; productSlug: string; newSubscriptions: number }[]> {
  const periodExpr = granularityExpr(granularity, "s.started_at");

  return resolveDbClient().all<{
    period: string;
    productSlug: string;
    newSubscriptions: number;
  }>(
    `select ${periodExpr} as period,
            coalesce(pr.slug, 'bundle') as productSlug,
            count(*) as newSubscriptions
     from subscriptions s
     left join products pr on pr.id = s.product_id
     where s.started_at >= ? and s.started_at < ?
     group by 1, 2
     order by 1, 2`,
    [fromISO, toISO],
  );
}
