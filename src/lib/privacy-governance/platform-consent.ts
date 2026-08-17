import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { DataPurpose } from "@/lib/privacy-governance/catalog";

export const CURRENT_PLATFORM_PRIVACY_CONSENT = {
  materialVersion: "pc-002-m1",
  noticeRevision: "2026-08-17.1",
  approvedPurposes: [
    "parent_identity",
    "learner_profile",
    "learning_personalization",
    "transactional_billing_notification",
    "anonymous_operational_analytics",
  ] as const satisfies readonly DataPurpose[],
} as const;

export type PlatformPrivacyConsentErrorCode =
  | "PLATFORM_PRIVACY_CONSENT_REQUIRED";

export class PlatformPrivacyConsentError extends Error {
  constructor(public readonly code: PlatformPrivacyConsentErrorCode) {
    super(code);
    this.name = "PlatformPrivacyConsentError";
  }
}

type ConsentRow = {
  id: string;
  parent_id: string;
  material_version: string;
  notice_revision: string;
  accepted_at: string;
};

export type PlatformPrivacyConsentAcceptance = {
  id: string;
  parentId: string;
  materialVersion: string;
  noticeRevision: string;
  acceptedAt: string;
};

// Supabase receives the canonical schema through migration 0052. This small
// additive mirror keeps the local SQLite/test adapter usable without teaching
// the generic schema bootstrap about a PC-specific production migration.
function ensureLocalConsentTable() {
  getDb().exec(`
    create table if not exists platform_privacy_consents (
      id text primary key,
      parent_id text not null,
      material_version text not null,
      notice_revision text not null,
      accepted_at text not null,
      unique(parent_id, material_version)
    );
    create index if not exists idx_platform_privacy_consents_parent
      on platform_privacy_consents(parent_id, material_version);
  `);
}

function toAcceptance(row: ConsentRow): PlatformPrivacyConsentAcceptance {
  return {
    id: row.id,
    parentId: row.parent_id,
    materialVersion: row.material_version,
    noticeRevision: row.notice_revision,
    acceptedAt: row.accepted_at,
  };
}

function currentRow(parentId: string): ConsentRow | undefined {
  ensureLocalConsentTable();
  return getDb().prepare(
    `select id,parent_id,material_version,notice_revision,accepted_at
     from platform_privacy_consents where parent_id=? and material_version=?`,
  ).get(parentId, CURRENT_PLATFORM_PRIVACY_CONSENT.materialVersion) as ConsentRow | undefined;
}

export function isPlatformPrivacyConsentMateriallyCurrent(
  acceptedMaterialVersion: string | null | undefined,
  requiredMaterialVersion: string = CURRENT_PLATFORM_PRIVACY_CONSENT.materialVersion,
) {
  return acceptedMaterialVersion === requiredMaterialVersion;
}

export function hasCurrentPlatformPrivacyConsent(parentId: string): boolean {
  return !!currentRow(parentId);
}

export function getCurrentPlatformPrivacyConsent(parentId: string): PlatformPrivacyConsentAcceptance | null {
  const row = currentRow(parentId);
  return row ? toAcceptance(row) : null;
}

export function requireCurrentPlatformPrivacyConsent(parentId: string): PlatformPrivacyConsentAcceptance {
  const acceptance = getCurrentPlatformPrivacyConsent(parentId);
  if (!acceptance) throw new PlatformPrivacyConsentError("PLATFORM_PRIVACY_CONSENT_REQUIRED");
  return acceptance;
}

// Callers can only say whether the parent explicitly accepted. They cannot
// choose a material version, purpose set, app, learner or session. That keeps
// the platform authority fail-closed and prevents consent from being widened
// by a feature-specific caller.
export function recordPlatformPrivacyConsent(
  parentId: string,
  accepted: boolean,
  now = new Date(),
): PlatformPrivacyConsentAcceptance {
  const existing = getCurrentPlatformPrivacyConsent(parentId);
  if (existing) return existing;
  if (accepted !== true) throw new PlatformPrivacyConsentError("PLATFORM_PRIVACY_CONSENT_REQUIRED");

  const acceptedAt = now.toISOString();
  getDb().prepare(
    `insert or ignore into platform_privacy_consents
     (id,parent_id,material_version,notice_revision,accepted_at) values(?,?,?,?,?)`,
  ).run(
    randomUUID(),
    parentId,
    CURRENT_PLATFORM_PRIVACY_CONSENT.materialVersion,
    CURRENT_PLATFORM_PRIVACY_CONSENT.noticeRevision,
    acceptedAt,
  );
  return requireCurrentPlatformPrivacyConsent(parentId);
}

export function capturePlatformPrivacyConsentAtSubscription(
  parentId: string,
  explicitlyAccepted: boolean,
  now = new Date(),
): PlatformPrivacyConsentAcceptance {
  const existing = getCurrentPlatformPrivacyConsent(parentId);
  if (existing) return existing;
  return recordPlatformPrivacyConsent(parentId, explicitlyAccepted, now);
}

export function platformPrivacyConsentCoversPurpose(purpose: string): purpose is DataPurpose {
  return (CURRENT_PLATFORM_PRIVACY_CONSENT.approvedPurposes as readonly string[]).includes(purpose);
}
