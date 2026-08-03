import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database("D:/Sridhar/Projects/BabyStepsIndia/data/babysteps.db");

const user = db.prepare("select id, email from users where email = 'parent@example.com'").get();
console.log("Test user:", user);

const mathProduct = db.prepare("select id, slug, status from products where slug = 'magical-math'").get();
console.log("Product:", mathProduct);

// Mirrors src/lib/db/subscriptions.ts insertActiveSubscription exactly
// (used by both createManualGrant and createSelfServeSubscription).
const subId = randomUUID();
const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 19)
  .replace("T", " ");

const tx = db.transaction(() => {
  db.prepare(
    `insert into subscriptions (id, user_id, type, product_id, status, razorpay_subscription_id, current_period_end)
     values (?, ?, 'single', ?, 'active', ?, ?)`,
  ).run(subId, user.id, mathProduct.id, `manual-${randomUUID()}`, periodEnd);

  db.prepare(
    `insert into subscription_audit_log (id, subscription_id, changed_by, change_type, old_status, new_status, note)
     values (?, ?, ?, 'created', NULL, 'active', 'Self-serve subscribe (no payment provider wired up yet)')`,
  ).run(randomUUID(), subId, `self:${user.email}`);
});
tx();

// Mirrors getEntitlementsForUser's single-product query
const entitled = db
  .prepare(
    `select p.slug from subscriptions s
     join products p on p.id = s.product_id
     where s.user_id = ? and s.type = 'single' and s.status = 'active'
       and s.current_period_end > datetime('now')`,
  )
  .all(user.id);
console.log("Entitled products after self-serve subscribe:", entitled);

const auditEntry = db
  .prepare("select changed_by, change_type, note from subscription_audit_log where subscription_id = ?")
  .get(subId);
console.log("Audit entry:", auditEntry);

const activeCount = db
  .prepare(
    `select coalesce(pr.slug, 'bundle') as slug, count(*) as n
     from subscriptions s left join products pr on pr.id = s.product_id
     where s.status in ('active','cancelling') group by 1`,
  )
  .all();
console.log("Active subscribers by product (for admin dashboard):", activeCount);
