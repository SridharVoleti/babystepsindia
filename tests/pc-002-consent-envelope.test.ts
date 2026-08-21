// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import {
  ConsentRequiredError, PROCESSING_ENVELOPE_VERSION, hasCurrentProcessingEnvelopeConsent,
  recordProcessingEnvelopeConsent, requireCurrentProcessingEnvelopeConsent,
} from "@/lib/db/consent";
import { completeParentOnboarding } from "@/lib/db/parent-profile-repo";

beforeEach(() => {
  useInMemoryDb();
});

async function parent(email: string) {
  return (await sqliteAuthAdapter.signUp(email, "CorrectHorse1!")).user.id;
}

describe("PC-002 processing-envelope consent (rules: central at platform level, fail closed)", () => {
  it("a parent who has never granted processing-envelope consent has none", async () => {
    const parentId = await parent(`p1-${randomUUID()}@example.com`);
    expect(hasCurrentProcessingEnvelopeConsent(parentId)).toBe(false);
  });

  it("recordProcessingEnvelopeConsent grants exactly the current version, idempotently", async () => {
    const parentId = await parent(`p2-${randomUUID()}@example.com`);
    recordProcessingEnvelopeConsent(parentId);
    recordProcessingEnvelopeConsent(parentId);
    expect(hasCurrentProcessingEnvelopeConsent(parentId)).toBe(true);
    const rows = getDb().prepare(
      "select count(*) as n from consent_records where parent_user_id=? and consent_type='processing_envelope'",
    ).get(parentId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("requireCurrentProcessingEnvelopeConsent throws ConsentRequiredError when absent", async () => {
    const parentId = await parent(`p3-${randomUUID()}@example.com`);
    expect(() => requireCurrentProcessingEnvelopeConsent(parentId)).toThrow(ConsentRequiredError);
  });

  it("onboarding completion records processing-envelope consent alongside terms/privacy — one grant covers every app in the envelope", async () => {
    const parentId = await parent(`p4-${randomUUID()}@example.com`);
    await completeParentOnboarding(parentId, {
      displayName: "Test Parent", phoneE164: "+919876543210", phoneCountryCode: "IN", locale: "en-IN", timezone: "Asia/Kolkata",
    });
    expect(hasCurrentProcessingEnvelopeConsent(parentId)).toBe(true);
    const termsGranted = getDb().prepare(
      "select 1 from consent_records where parent_user_id=? and consent_type='terms_of_service'",
    ).get(parentId);
    expect(termsGranted).toBeTruthy();
  });

  it("a material version bump makes prior consent insufficient until re-granted", async () => {
    const parentId = await parent(`p5-${randomUUID()}@example.com`);
    recordProcessingEnvelopeConsent(parentId, "0.9-superseded");
    expect(hasCurrentProcessingEnvelopeConsent(parentId)).toBe(false);
    recordProcessingEnvelopeConsent(parentId, PROCESSING_ENVELOPE_VERSION);
    expect(hasCurrentProcessingEnvelopeConsent(parentId)).toBe(true);
  });
});
