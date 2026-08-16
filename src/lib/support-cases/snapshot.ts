import { getDb } from "@/lib/db/client";
import { maskEmail } from "@/lib/account/mask";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { composeLearnerHome } from "@/lib/learner-home/service";
import { readLearnerAppSummarySnapshot } from "@/lib/app-progress/summary-read";
import { readProgressVisibilitySnapshot } from "@/lib/progress-integrity/service";
import { composeParentCommunicationHistory } from "@/lib/notification-history/service";
import type {
  BillingSafeSection, LearnerSafeSection, NotificationSafeSection, ParentSafeSection, ProgressSafeSection,
  SupportCaseCategory, TechnicalIssueSafeSection,
} from "./contracts";

type CaseRow = {
  id: string; category: SupportCaseCategory; parent_id: string; learner_id: string | null;
  app_id: string | null; subscription_id: string | null;
};

// Rule 38: DOB is hidden by default; only a coarse band, and only for
// categories where the case actually needs learner-age context.
function ageBand(ageYears: number): string {
  if (ageYears < 6) return "under_6";
  if (ageYears <= 8) return "6_8";
  if (ageYears <= 11) return "9_11";
  if (ageYears <= 13) return "12_13";
  return "14_plus";
}

function composeParentSection(parentId: string): ParentSafeSection {
  const user = getDb().prepare("select email, created_at from users where id=?").get(parentId) as
    { email: string; created_at: string };
  const profile = getDb().prepare("select display_name, account_status from profiles where id=?").get(parentId) as
    { display_name: string | null; account_status: string };
  return {
    displayName: profile.display_name, maskedEmail: maskEmail(user.email),
    accountStatus: profile.account_status, accountCreatedAt: user.created_at,
  };
}

// Rules 37-40: learner name/access-state/app-membership only — never raw
// progress, answers, mastery formula or exact DOB.
function composeLearnerSection(parentId: string, learnerId: string, includeAgeBand: boolean): LearnerSafeSection | undefined {
  const ageAsOfDate = calendarDateInTimeZone(getParentTimezone(parentId));
  const learner = listOwnedLearners(parentId, ageAsOfDate).find((l) => l.id === learnerId);
  if (!learner) return undefined;
  const home = composeLearnerHome(learnerId, "production", new Date());
  return {
    learnerId, displayName: learner.displayName,
    ageBand: includeAgeBand ? ageBand(learner.ageYears) : null,
    apps: home.cards.map((card) => ({ appId: card.appId, appName: card.appName, entitlementState: card.status })),
  };
}

// Rules 39, 44: parent-safe PR-003 summary + PR-004 integrity state only —
// never the raw progress JSON, mastery formula or question history.
function composeProgressSection(learnerId: string, appId: string): ProgressSafeSection {
  const summary = readLearnerAppSummarySnapshot(learnerId, appId);
  const integrity = readProgressVisibilitySnapshot(learnerId, appId);
  return {
    appId,
    currentLevel: integrity.readSafe && summary.summary ? summary.summary.currentLevel : null,
    nextDestination: integrity.readSafe && summary.summary ? summary.summary.nextDestination : null,
    integrityState: integrity.classification,
  };
}

// Rule 41: product/bundle, assigned learner, billing cycle, payment/grace/
// cancellation status and a safe invoice summary only — never payment
// credentials or provider secrets.
function composeBillingSection(subscriptionId: string): BillingSafeSection | undefined {
  const row = getDb().prepare(
    `select s.id, p.name as product_name, s.payment_state, s.cancel_at_period_end, s.grace_ends_at,
            s.current_period_end
     from subscriptions s join products p on p.id=s.product_id where s.id=?`,
  ).get(subscriptionId) as {
    id: string; product_name: string; payment_state: string; cancel_at_period_end: number;
    grace_ends_at: string | null; current_period_end: string;
  } | undefined;
  if (!row) return undefined;
  return {
    subscriptionId: row.id, productName: row.product_name,
    billingCycleStatus: `renews_${row.current_period_end}`,
    gracePaymentStatus: row.grace_ends_at ? `grace_until_${row.grace_ends_at}` : null,
    cancellationStatus: row.cancel_at_period_end === 1 ? "cancel_at_period_end" : null,
    safeInvoiceSummary: null,
  };
}

// Rule 43: safe NT-001/NT-002 delivery state only — reuses NT-002's own
// already-safe communication-history composer, never a second read path.
function composeNotificationSection(parentId: string): NotificationSafeSection[] {
  const history = composeParentCommunicationHistory(parentId, { limit: "5" }, new Date());
  return history.items.map((item) => ({
    notificationType: item.title, state: item.deliveryState, deliveryState: item.deliveryState,
  }));
}

// Rule 45: safe session ID/status/timestamps only — never the answer/
// progress payload itself.
function composeTechnicalIssueSection(learnerId: string): TechnicalIssueSafeSection | undefined {
  const row = getDb().prepare(
    "select id, status, updated_at from learner_sessions where learner_id=? order by updated_at desc limit 1",
  ).get(learnerId) as { id: string; status: string; updated_at: string } | undefined;
  if (!row) return undefined;
  return { sessionId: row.id, status: row.status, lastUpdatedAt: row.updated_at };
}

// Rules 34, 46-47: composed live from owning domains every read, never a
// duplicate customer snapshot table. Rule 46: category strictly limits
// which sections are fetched at all — never load unrelated domains just
// because a multi-role staff member could reach them elsewhere.
export function composeCaseSnapshotSections(caseId: string) {
  const row = getDb().prepare(
    "select id, category, parent_id, learner_id, app_id, subscription_id from support_cases where id=?",
  ).get(caseId) as CaseRow | undefined;
  if (!row) return null;

  const sections: {
    parent: ParentSafeSection; learner?: LearnerSafeSection; progress?: ProgressSafeSection;
    billing?: BillingSafeSection; notifications?: NotificationSafeSection[]; technicalIssue?: TechnicalIssueSafeSection;
  } = { parent: composeParentSection(row.parent_id) };

  const needsLearner = ["learner_access", "app_access", "progress_display", "technical_issue"].includes(row.category);
  if (needsLearner && row.learner_id) {
    sections.learner = composeLearnerSection(row.parent_id, row.learner_id,
      row.category === "learner_access" || row.category === "progress_display");
  }
  if (row.category === "progress_display" && row.learner_id && row.app_id) {
    sections.progress = composeProgressSection(row.learner_id, row.app_id);
  }
  if (["billing_question", "subscription_assignment", "payment_refund"].includes(row.category) && row.subscription_id) {
    sections.billing = composeBillingSection(row.subscription_id);
  }
  if (row.category === "notification_delivery") {
    sections.notifications = composeNotificationSection(row.parent_id);
  }
  if (row.category === "technical_issue" && row.learner_id) {
    sections.technicalIssue = composeTechnicalIssueSection(row.learner_id);
  }
  return sections;
}
