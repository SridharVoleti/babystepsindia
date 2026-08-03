import { normalizePhone } from "@/lib/parent-profile/phone";
import { POLICY_VERSION } from "@/lib/db/consent";

export type OnboardingInput = {
  displayName?: string | null;
  phoneCountryCode: string;
  mobileNumber: string;
  locale?: string;
  timezone?: string;
  acceptedTermsVersion: string;
  acceptedPrivacyVersion: string;
};

export type ValidatedOnboarding = {
  displayName: string | null;
  phoneE164: string;
  phoneCountryCode: string;
  locale: string;
  timezone: string;
};

export type OnboardingValidationErrorCode =
  | "DISPLAY_NAME_INVALID"
  | "PHONE_REQUIRED"
  | "PHONE_INVALID"
  | "POLICY_REQUIRED"
  | "POLICY_VERSION_OUTDATED";

export type ValidateOnboardingResult =
  | { ok: true; value: ValidatedOnboarding }
  | { ok: false; code: OnboardingValidationErrorCode; error: string };

// IA-002: mobile is mandatory and format-validated only (no OTP); display
// name is optional; postal address/DOB are never read from input, so
// extra/unexpected fields on the payload are simply ignored (AC10).
export function validateOnboarding(input: OnboardingInput): ValidateOnboardingResult {
  const rawName = (input.displayName ?? "").trim();
  if (rawName.length > 100) {
    return { ok: false, code: "DISPLAY_NAME_INVALID", error: "Name must be 100 characters or fewer." };
  }
  const displayName = rawName.length > 0 ? rawName : null;

  if (!input.phoneCountryCode || !input.mobileNumber?.trim()) {
    return { ok: false, code: "PHONE_REQUIRED", error: "Enter a mobile number." };
  }

  const phoneResult = normalizePhone(input.phoneCountryCode, input.mobileNumber);
  if (!phoneResult.ok) {
    return { ok: false, code: "PHONE_INVALID", error: phoneResult.error };
  }

  if (!input.acceptedTermsVersion) {
    return { ok: false, code: "POLICY_REQUIRED", error: "Accept the Terms of Service to continue." };
  }
  if (!input.acceptedPrivacyVersion) {
    return { ok: false, code: "POLICY_REQUIRED", error: "Accept the Privacy Policy to continue." };
  }
  if (input.acceptedTermsVersion !== POLICY_VERSION || input.acceptedPrivacyVersion !== POLICY_VERSION) {
    return {
      ok: false,
      code: "POLICY_VERSION_OUTDATED",
      error: "The Terms and Privacy Policy have been updated — please review and accept the current version.",
    };
  }

  return {
    ok: true,
    value: {
      displayName,
      phoneE164: phoneResult.e164,
      phoneCountryCode: input.phoneCountryCode,
      locale: input.locale?.trim() || "en-IN",
      timezone: input.timezone?.trim() || "Asia/Kolkata",
    },
  };
}
