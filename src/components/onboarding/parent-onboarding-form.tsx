"use client";

import { useState } from "react";
import { normalizePhone } from "@/lib/parent-profile/phone";
import { PHONE_COUNTRIES, DEFAULT_PHONE_COUNTRY } from "@/lib/parent-profile/countries";
import type { OnboardingProfileView } from "@/lib/db/parent-profile-repo";

// Plain useState + fetch + window.location — deliberately no
// next/navigation useRouter (needs Next's App Router context, which
// doesn't exist under Vitest/jsdom — see tests/parent-onboarding-form
// .test.tsx) and no useFormState/useFormStatus (not exported by the
// installed react-dom outside Next's own bundler, per the IA-001 forms).
// A full navigation also re-runs the server-side onboarding guard fresh,
// which a soft client transition might not.
export function ParentOnboardingForm({
  initialProfile,
}: {
  initialProfile: OnboardingProfileView;
}) {
  const [displayName, setDisplayName] = useState(initialProfile.displayName ?? "");
  const [countryCode, setCountryCode] = useState(
    initialProfile.phoneCountryCode ?? DEFAULT_PHONE_COUNTRY,
  );
  const [mobileNumber, setMobileNumber] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneResult = normalizePhone(countryCode, mobileNumber);
  const canSubmit = phoneResult.ok && acceptedTerms && acceptedPrivacy && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!phoneResult.ok) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/v1/parent/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          phoneCountryCode: countryCode,
          mobileNumber,
          acceptedTermsVersion: initialProfile.currentPolicyVersions.termsOfService,
          acceptedPrivacyVersion: initialProfile.currentPolicyVersions.privacyPolicy,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      window.location.href = "/account";
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800"
        >
          {error}
        </p>
      )}

      <div>
        <label htmlFor="email" className="field-label">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={initialProfile.email}
          readOnly
          className="field-input bg-chakra-50 text-chakra-500"
        />
      </div>

      <div>
        <label htmlFor="displayName" className="field-label">
          Parent name (optional)
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="mobileNumber" className="field-label">
          Mobile number
        </label>
        <div className="flex gap-2">
          <select
            aria-label="Country"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="field-input w-auto"
          >
            {PHONE_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.callingCode})
              </option>
            ))}
          </select>
          <input
            id="mobileNumber"
            name="mobileNumber"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            value={mobileNumber}
            onChange={(e) => setMobileNumber(e.target.value)}
            required
            className="field-input flex-1"
          />
        </div>
        {mobileNumber.trim() && !phoneResult.ok && (
          <p className="mt-1.5 text-xs text-saffron-700">{phoneResult.error}</p>
        )}
        <p className="mt-1.5 text-xs text-chakra-400">
          We only check the format — no verification call or text is sent.
        </p>
      </div>

      <div className="space-y-2 text-sm text-chakra-600">
        <label htmlFor="acceptedTerms" className="flex items-start gap-2">
          <input
            id="acceptedTerms"
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I accept the{" "}
            <a href="/terms" className="font-medium text-green-700 hover:text-green-800">
              Terms of Service
            </a>
          </span>
        </label>
        <label htmlFor="acceptedPrivacy" className="flex items-start gap-2">
          <input
            id="acceptedPrivacy"
            type="checkbox"
            checked={acceptedPrivacy}
            onChange={(e) => setAcceptedPrivacy(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I accept the{" "}
            <a href="/privacy" className="font-medium text-green-700 hover:text-green-800">
              Privacy Policy
            </a>
          </span>
        </label>
      </div>

      <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
        {submitting ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
