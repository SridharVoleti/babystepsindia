import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { ConsentType } from "@/lib/db/types";

// Bump when Terms/Privacy copy changes; recorded per-acceptance so past
// consent stays tied to the version the parent actually agreed to.
export const POLICY_VERSION = "1.0";

// Idempotent: the unique(parent_user_id, consent_type, policy_version)
// constraint means a repeated signup/onboarding submission re-grants the
// same row instead of inserting a duplicate (IA-002 AC13/business rule 14).
export function recordConsent(
  parentUserId: string,
  consentType: ConsentType,
  policyVersion: string = POLICY_VERSION,
) {
  getDb()
    .prepare(
      `insert into consent_records (id, parent_user_id, consent_type, policy_version, granted, granted_at)
       values (?, ?, ?, ?, 1, datetime('now'))
       on conflict (parent_user_id, consent_type, policy_version)
       do update set granted = 1, granted_at = datetime('now'), revoked_at = null
       where consent_records.granted = 0 or consent_records.revoked_at is not null`,
    )
    .run(randomUUID(), parentUserId, consentType, policyVersion);
}

export function hasCurrentConsent(
  parentUserId: string,
  consentType: ConsentType,
  policyVersion: string = POLICY_VERSION,
): boolean {
  const row = getDb()
    .prepare(
      `select 1 from consent_records
       where parent_user_id = ? and consent_type = ? and policy_version = ? and granted = 1`,
    )
    .get(parentUserId, consentType, policyVersion);
  return !!row;
}
