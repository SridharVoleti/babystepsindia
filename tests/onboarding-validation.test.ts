import { describe, expect, it } from "vitest";
import { validateOnboarding } from "@/lib/parent-profile/onboarding-validation";
import { POLICY_VERSION } from "@/lib/db/consent";

const validInput = {
  displayName: "Asha Verma",
  phoneCountryCode: "IN",
  mobileNumber: "9876543210",
  acceptedTermsVersion: POLICY_VERSION,
  acceptedPrivacyVersion: POLICY_VERSION,
};

describe("validateOnboarding", () => {
  it("accepts a valid submission and normalizes the phone to E.164", () => {
    const result = validateOnboarding(validInput);
    expect(result).toEqual({
      ok: true,
      value: {
        displayName: "Asha Verma",
        phoneE164: "+919876543210",
        phoneCountryCode: "IN",
        locale: "en-IN",
        timezone: "Asia/Kolkata",
      },
    });
  });

  it("accepts a blank display name and stores it as null (AC6/AT-IA-002-06)", () => {
    const result = validateOnboarding({ ...validInput, displayName: "" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.displayName).toBeNull();
  });

  it("treats a whitespace-only display name as null", () => {
    const result = validateOnboarding({ ...validInput, displayName: "   " });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.displayName).toBeNull();
  });

  it("rejects a missing mobile number (AC3/AT-IA-002-03)", () => {
    const result = validateOnboarding({ ...validInput, mobileNumber: "" });
    expect(result).toMatchObject({ ok: false, code: "PHONE_REQUIRED" });
  });

  it("rejects an invalid mobile number for the selected country (AT-IA-002-04)", () => {
    const result = validateOnboarding({ ...validInput, mobileNumber: "123" });
    expect(result).toMatchObject({ ok: false, code: "PHONE_INVALID" });
  });

  it("rejects a display name over 100 characters", () => {
    const result = validateOnboarding({ ...validInput, displayName: "a".repeat(101) });
    expect(result).toMatchObject({ ok: false, code: "DISPLAY_NAME_INVALID" });
  });

  it("rejects missing policy acceptance", () => {
    const result = validateOnboarding({ ...validInput, acceptedTermsVersion: "" });
    expect(result).toMatchObject({ ok: false, code: "POLICY_REQUIRED" });
  });

  it("rejects an outdated policy version", () => {
    const result = validateOnboarding({ ...validInput, acceptedPrivacyVersion: "0.9" });
    expect(result).toMatchObject({ ok: false, code: "POLICY_VERSION_OUTDATED" });
  });

  it("defaults locale/timezone when not supplied", () => {
    // validInput deliberately has no locale/timezone fields.
    const result = validateOnboarding(validInput);
    expect(result.ok && result.value.locale).toBe("en-IN");
    expect(result.ok && result.value.timezone).toBe("Asia/Kolkata");
  });

  it("ignores unexpected/extra fields like postal address (AC10/AT-IA-002-10)", () => {
    const result = validateOnboarding({
      ...validInput,
      postalAddress: "123 Fake St",
      dateOfBirth: "1990-01-01",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.ok && (result.value as Record<string, unknown>).postalAddress).toBeUndefined();
  });
});
