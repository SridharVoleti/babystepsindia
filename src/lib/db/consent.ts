import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

// Bump when Terms/Privacy copy changes; recorded per-acceptance so past
// consent stays tied to the version the parent actually agreed to.
export const POLICY_VERSION = "1.0";

export function recordConsentAcceptance(
  userId: string,
  policyType: "terms" | "privacy",
  policyVersion: string = POLICY_VERSION,
) {
  getDb()
    .prepare(
      "insert into consent_acceptances (id, user_id, policy_type, policy_version) values (?, ?, ?, ?)",
    )
    .run(randomUUID(), userId, policyType, policyVersion);
}
