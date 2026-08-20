import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { ConsentType } from "@/lib/db/types";

// Bump when Terms/Privacy copy changes; recorded per-acceptance so past
// consent stays tied to the version the parent actually agreed to.
export const POLICY_VERSION = "1.0";

// Idempotent: the unique(parent_user_id, consent_type, policy_version)
// constraint means a repeated signup/onboarding submission re-grants the
// same row instead of inserting a duplicate (IA-002 AC13/business rule 14).
export async function recordConsent(
  parentUserId: string,
  consentType: ConsentType,
  policyVersion: string = POLICY_VERSION,
) {
  const now = new Date().toISOString();
  await resolveDbClient().run(
    `insert into consent_records (id, parent_user_id, consent_type, policy_version, granted, granted_at)
     values (?, ?, ?, ?, 1, ?)
     on conflict (parent_user_id, consent_type, policy_version)
     do update set granted = 1, granted_at = ?, revoked_at = null
     where consent_records.granted = 0 or consent_records.revoked_at is not null`,
    [randomUUID(), parentUserId, consentType, policyVersion, now, now],
  );
}

export async function hasCurrentConsent(
  parentUserId: string,
  consentType: ConsentType,
  policyVersion: string = POLICY_VERSION,
): Promise<boolean> {
  const row = await resolveDbClient().get(
    `select 1 from consent_records
     where parent_user_id = ? and consent_type = ? and policy_version = ? and granted = 1`,
    [parentUserId, consentType, policyVersion],
  );
  return !!row;
}

// PC-002: independent from POLICY_VERSION (terms/privacy legal copy) —
// this tracks material changes to WHAT data is collected/processed/
// exposed across apps and providers ("the processing envelope"), not
// legal-text edits. Bump only when a change is actually material (rule:
// "renew only for material changes to data collection, processing
// purpose or approved exposure"); a non-material change (copy-editing,
// clarifying wording) must never bump this.
export const PROCESSING_ENVELOPE_VERSION = "1.0";

export async function recordProcessingEnvelopeConsent(parentUserId: string, version: string = PROCESSING_ENVELOPE_VERSION) {
  await recordConsent(parentUserId, "processing_envelope", version);
}

// One consent at the current envelope version covers every subscribed
// app/provider inside that same envelope (rule: "one consent may cover
// multiple subscribed apps... adding another app does not require fresh
// consent if processing is unchanged") — this is a single parent-level
// check, never scoped per-app, which is what makes that true by
// construction rather than by a second per-app consent flow.
export async function hasCurrentProcessingEnvelopeConsent(parentUserId: string): Promise<boolean> {
  return hasCurrentConsent(parentUserId, "processing_envelope", PROCESSING_ENVELOPE_VERSION);
}

export class ConsentRequiredError extends Error {
  constructor() {
    super("PROCESSING_CONSENT_REQUIRED");
    this.name = "ConsentRequiredError";
  }
}

// The fail-closed gate itself (rule: "required processing fails closed
// without current consent") — called at subscription/checkout activation,
// the frozen "central... at platform level" enforcement point.
export async function requireCurrentProcessingEnvelopeConsent(parentUserId: string): Promise<void> {
  if (!(await hasCurrentProcessingEnvelopeConsent(parentUserId))) throw new ConsentRequiredError();
}
