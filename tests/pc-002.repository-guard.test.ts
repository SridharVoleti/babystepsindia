import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

describe("PC-002 repository guards", () => {
  it("keeps platform consent evidence free of app, learner, session and contact dimensions", () => {
    const migration = source("supabase/migrations/0052_pc002_consent_management.sql");
    const block = migration.match(/create table platform_privacy_consents \(([\s\S]*?)\);/i)?.[1] ?? "";
    expect(block).toContain("parent_id");
    expect(block).toContain("material_version");
    expect(block).toContain("notice_revision");
    expect(block).not.toMatch(/app_id|learner_id|session_id|email|phone/i);
  });

  it("separates material consent version from non-material notice revision", () => {
    const implementation = source("src/lib/privacy-governance/platform-consent.ts");
    expect(implementation).toContain('materialVersion: "pc-002-m1"');
    expect(implementation).toContain('noticeRevision: "2026-08-17.1"');
    expect(implementation).toContain("isPlatformPrivacyConsentMateriallyCurrent");
  });

  it("does not let feature callers choose a consent material version or purpose list", () => {
    const implementation = source("src/lib/privacy-governance/platform-consent.ts");
    const recordSignature = implementation.match(/export function recordPlatformPrivacyConsent\(([\s\S]*?)\): PlatformPrivacyConsentAcceptance/)?.[1] ?? "";
    expect(recordSignature).toContain("parentId: string");
    expect(recordSignature).toContain("accepted: boolean");
    expect(recordSignature).not.toContain("materialVersion");
    expect(recordSignature).not.toContain("purposes");
  });

  it("keeps billing disclosure consent distinct from PC-002 platform privacy consent", () => {
    const route = source("src/app/v1/billing/checkout-intents/route.ts");
    expect(route).toContain("consentDisclosureVersion");
    expect(route).toContain("privacyConsentAccepted");
    expect(route).toContain("capturePlatformPrivacyConsentAtSubscription");
  });

  it("fails closed at the production subscription activation boundary", () => {
    const migration = source("supabase/migrations/0052_pc002_consent_management.sql");
    expect(migration).toContain("subscriptions_require_platform_privacy_consent");
    expect(migration).toContain("PLATFORM_PRIVACY_CONSENT_REQUIRED");
    expect(migration).toContain("new.status = 'active'");
    expect(migration).toContain("old.status is distinct from 'active'");
  });
});
