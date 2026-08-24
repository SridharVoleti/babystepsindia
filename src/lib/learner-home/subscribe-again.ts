import { resolveDbClient } from "@/lib/db-client";
import { evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";
import { hasProductAccessOverlap } from "@/lib/billing/bi001-service";
import { LearnerHomeError } from "@/lib/learner-home/past-apps";

export type SubscribeAgainContinuation =
  | { eligible: true; productId: string; productSlug: string; productVersion: number; learnerId: string }
  | { eligible: false; reason: "app_still_accessible" | "not_currently_sold" | "multiple_current_products" | "overlap" };

async function assertOwnedLearner(parentUserId: string, learnerId: string) {
  const row = await resolveDbClient().get("select 1 from learners where id=? and owner_parent_id=?", [learnerId, parentUserId]);
  if (!row) throw new LearnerHomeError("RESOURCE_NOT_FOUND");
}

async function resolveCurrentProductsForApp(appId: string): Promise<{ id: string; slug: string; version: number }[]> {
  return resolveDbClient().all(
    `select p.id, p.slug, p.version from products p
     join product_version_apps pva on pva.product_id=p.id and pva.product_version=p.version
     where pva.app_id=? and p.status='active'`,
    [appId],
  );
}

// UL-001 rules 59-63: re-validates eligibility server-side rather than
// trusting whatever a stale Past-apps card showed the parent — same
// checks listPastApps applies, run fresh for this one app. Does not
// create a checkout_intents row itself (see README for the design
// rationale) — returns a continuation payload the client hands off to
// the existing, unmodified BI-002 review screen.
export async function resolveSubscribeAgainContinuation(
  parentUserId: string, learnerId: string, appId: string, now: Date,
): Promise<SubscribeAgainContinuation> {
  await assertOwnedLearner(parentUserId, learnerId);
  const environment = "production";
  const decision = await evaluateAccessForLauncher({ learnerId, appId, environment, now });
  if (decision.allowed && (decision.state === "active" || decision.state === "grace")) {
    return { eligible: false, reason: "app_still_accessible" };
  }
  const products = await resolveCurrentProductsForApp(appId);
  if (products.length === 0) return { eligible: false, reason: "not_currently_sold" };
  if (products.length > 1) return { eligible: false, reason: "multiple_current_products" };
  const product = products[0];
  if (hasProductAccessOverlap(learnerId, product.id, product.version, now)) return { eligible: false, reason: "overlap" };
  return { eligible: true, productId: product.id, productSlug: product.slug, productVersion: product.version, learnerId };
}
