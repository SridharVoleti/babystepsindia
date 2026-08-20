import { resolveDbClient } from "@/lib/db-client";
import { evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";
import { getApp } from "@/lib/db/app-registry-repo";
import { hasProductAccessOverlap } from "@/lib/billing/bi001-service";
import { readLearnerAppSummarySnapshot } from "@/lib/app-progress/summary-read";
import { readProgressVisibilitySnapshot } from "@/lib/progress-integrity/service";
import { readCurrentConsistency } from "@/lib/consistency/service";

export class LearnerHomeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "LearnerHomeError"; }
}

export type PastAppCard = {
  appId: string;
  appName: string;
  iconAssetKey: string | null;
  accessEndedDate: string | null;
  lastSafeSummary: import("@/lib/progress-motivation/contracts").ProgressSummary | null;
  summaryUnavailableReason: "preserved_progress_unavailable" | null;
  consistency: { lastCurrentStreakWeeks: number; longestStreakWeeks: number };
  subscribeAgain:
    | { offered: true; productId: string; productSlug: string; productVersion: number }
    | { offered: false; reason: "not_currently_sold" | "multiple_current_products" | "overlap" };
};

async function assertOwnedLearner(parentUserId: string, learnerId: string) {
  const row = await resolveDbClient().get("select 1 from learners where id=? and owner_parent_id=?", [learnerId, parentUserId]);
  if (!row) throw new LearnerHomeError("RESOURCE_NOT_FOUND");
}

// Resolves the single current (active-status, current-version) product
// that includes this app, if any — mirrors productAppIds' own
// product-version join in bi001-service.ts. More than one match is a
// fail-closed "don't guess which one" case (rule 66: no silent
// substitution), not a bug.
async function resolveCurrentProductsForApp(appId: string): Promise<{ id: string; slug: string; version: number }[]> {
  return resolveDbClient().all(
    `select p.id, p.slug, p.version from products p
     join product_version_apps pva on pva.product_id=p.id and pva.product_version=p.version
     where pva.app_id=? and p.status='active'`,
    [appId],
  );
}

async function resolveSubscribeAgain(learnerId: string, appId: string, now: Date): Promise<PastAppCard["subscribeAgain"]> {
  const products = await resolveCurrentProductsForApp(appId);
  if (products.length === 0) return { offered: false, reason: "not_currently_sold" };
  if (products.length > 1) return { offered: false, reason: "multiple_current_products" };
  const product = products[0];
  if (hasProductAccessOverlap(learnerId, product.id, product.version, now)) return { offered: false, reason: "overlap" };
  return { offered: true, productId: product.id, productSlug: product.slug, productVersion: product.version };
}

// UL-001 rules 48-59: one card per learner-app whose access has ended,
// visible only to the direct owning parent. Excludes any app the learner
// still has active/grace access to via the same live check the launcher
// itself uses — the raw .state column can't be trusted for this since
// grace coverage is computed dynamically and never persisted back to it.
export async function listPastApps(parentUserId: string, learnerId: string, now: Date): Promise<PastAppCard[]> {
  await assertOwnedLearner(parentUserId, learnerId);
  const environment = "production";
  const rows = await resolveDbClient().all<{ app_id: string; access_until: string | null }>(
    `select app_id, access_until from learner_app_effective_entitlements where learner_id=? and environment=?`,
    [learnerId, environment],
  );

  const cards: PastAppCard[] = [];
  for (const row of rows) {
    const decision = evaluateAccessForLauncher({ learnerId, appId: row.app_id, environment, now });
    if (decision.allowed && (decision.state === "active" || decision.state === "grace")) continue;

    const app = await getApp(row.app_id);
    if (!app) continue; // defensive — shouldn't happen, an FK-restricted app can't be removed while referenced

    const summarySnapshot = await readLearnerAppSummarySnapshot(learnerId, row.app_id);
    const visibility = readProgressVisibilitySnapshot(learnerId, row.app_id);
    const lastSafeSummary = visibility.readSafe ? summarySnapshot.summary : null;
    const consistency = readCurrentConsistency(learnerId, row.app_id, environment, now);

    cards.push({
      appId: row.app_id, appName: app.displayName, iconAssetKey: app.iconAssetKey,
      accessEndedDate: row.access_until,
      lastSafeSummary,
      summaryUnavailableReason: lastSafeSummary ? null : "preserved_progress_unavailable",
      consistency: { lastCurrentStreakWeeks: consistency.currentStreakWeeks,
        longestStreakWeeks: consistency.longestStreakWeeks },
      subscribeAgain: await resolveSubscribeAgain(learnerId, row.app_id, now),
    });
  }
  return cards;
}
