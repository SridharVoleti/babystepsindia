import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { recordConsent } from "@/lib/db/consent";
import {
  CURRENT_PLATFORM_PRIVACY_CONSENT,
  PlatformPrivacyConsentError,
  capturePlatformPrivacyConsentAtSubscription,
  hasCurrentPlatformPrivacyConsent,
  isPlatformPrivacyConsentMateriallyCurrent,
  recordPlatformPrivacyConsent,
  requireCurrentPlatformPrivacyConsent,
  platformPrivacyConsentCoversPurpose,
} from "@/lib/privacy-governance/platform-consent";

let parentId: string;
const NOW = new Date("2026-08-17T07:30:00.000Z");

beforeEach(async () => {
  useInMemoryDb();
  parentId = (await sqliteAuthAdapter.signUp("pc002-parent@example.com", "CorrectHorse1!")).user.id;
});

describe("PC-002 — Consent Management", () => {
  it("fails closed until the purchasing parent accepts the current material platform consent", () => {
    expect(hasCurrentPlatformPrivacyConsent(parentId)).toBe(false);
    expect(() => requireCurrentPlatformPrivacyConsent(parentId)).toThrow(
      new PlatformPrivacyConsentError("PLATFORM_PRIVACY_CONSENT_REQUIRED"),
    );
  });

  it("records one immutable parent-level acceptance for the current material version", () => {
    const first = recordPlatformPrivacyConsent(parentId, true, NOW);
    const second = recordPlatformPrivacyConsent(parentId, true, new Date("2026-08-17T08:00:00.000Z"));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      parentId,
      materialVersion: CURRENT_PLATFORM_PRIVACY_CONSENT.materialVersion,
      noticeRevision: CURRENT_PLATFORM_PRIVACY_CONSENT.noticeRevision,
      acceptedAt: NOW.toISOString(),
    });
    expect((getDb().prepare("select count(*) n from platform_privacy_consents where parent_id=?")
      .get(parentId) as { n: number }).n).toBe(1);
  });

  it("never infers privacy consent from billing/legacy privacy-policy acceptance", () => {
    recordConsent(parentId, "privacy_policy");
    expect(hasCurrentPlatformPrivacyConsent(parentId)).toBe(false);
  });

  it("is platform-scoped rather than app, learner or session scoped", () => {
    recordPlatformPrivacyConsent(parentId, true, NOW);
    const columns = (getDb().prepare("pragma table_info(platform_privacy_consents)").all() as { name: string }[])
      .map((row) => row.name);
    expect(columns).toEqual(["id", "parent_id", "material_version", "notice_revision", "accepted_at"]);
    expect(columns).not.toContain("app_id");
    expect(columns).not.toContain("learner_id");
    expect(columns).not.toContain("session_id");
    expect(columns).not.toContain("email");
  });

  it("does not require renewed consent for a non-material notice revision", () => {
    expect(isPlatformPrivacyConsentMateriallyCurrent("pc-002-m1", "pc-002-m1")).toBe(true);
  });

  it("requires renewed consent when the material consent version changes", () => {
    expect(isPlatformPrivacyConsentMateriallyCurrent("pc-002-m1", "pc-002-m2")).toBe(false);
  });

  it("preserves historical acceptance evidence across material versions", () => {
    recordPlatformPrivacyConsent(parentId, true, NOW);
    getDb().prepare(
      `insert into platform_privacy_consents(id,parent_id,material_version,notice_revision,accepted_at)
       values(?,?,?,?,?)`,
    ).run("pc002-new-version", parentId, "pc-002-m2", "2026-09-01.1", "2026-09-01T00:00:00.000Z");
    const rows = getDb().prepare(
      "select material_version from platform_privacy_consents where parent_id=? order by accepted_at",
    ).all(parentId) as { material_version: string }[];
    expect(rows.map((row) => row.material_version)).toEqual(["pc-002-m1", "pc-002-m2"]);
  });

  it("captures consent only from an explicit subscribe/activate acceptance", () => {
    expect(() => capturePlatformPrivacyConsentAtSubscription(parentId, false, NOW)).toThrow(
      new PlatformPrivacyConsentError("PLATFORM_PRIVACY_CONSENT_REQUIRED"),
    );
    expect(capturePlatformPrivacyConsentAtSubscription(parentId, true, NOW).materialVersion)
      .toBe(CURRENT_PLATFORM_PRIVACY_CONSENT.materialVersion);
  });

  it("covers only approved platform purposes and cannot legalize PC-001 prohibited purposes", () => {
    expect(platformPrivacyConsentCoversPurpose("parent_identity")).toBe(true);
    expect(platformPrivacyConsentCoversPurpose("learning_personalization")).toBe(true);
    expect(platformPrivacyConsentCoversPurpose("behavioral_tracking")).toBe(false);
    expect(platformPrivacyConsentCoversPurpose("advertising")).toBe(false);
  });
});
