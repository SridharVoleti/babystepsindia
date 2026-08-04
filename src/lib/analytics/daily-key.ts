import { createHmac } from "node:crypto";
import { AnalyticsError } from "@/lib/analytics/errors";

// Security & Privacy: "Analytics secret is separate from
// authentication/signing secrets and stored only in the secrets
// manager." — a dedicated env var, never shared with AUTH_SECRET or
// LEARNING_SESSION_SECRET. Missing/too-short secret fails closed
// (business rule/AT-AN-001-29) rather than falling back to any
// predictable or plain identifier.
function analyticsSecret(): string {
  const value = process.env.ANALYTICS_HMAC_SECRET;
  if (!value || value.length < 32) throw new AnalyticsError("ANALYTICS_SECRET_MISSING");
  return value;
}

// Business rule 6: HMAC-SHA256 over (learner_id, activity_date) using the
// dedicated analytics secret. Changes daily by construction and is never
// reversible back to the raw learner id.
export function learnerDailyKey(learnerId: string, activityDate: string): string {
  return createHmac("sha256", analyticsSecret()).update(`${activityDate}:${learnerId}`).digest("hex");
}
