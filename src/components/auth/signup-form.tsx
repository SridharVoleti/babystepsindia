"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { signUpAction } from "@/app/(auth)/actions";
import { initialAuthState, type AuthActionState } from "@/lib/auth-types";
import { PasswordField } from "@/components/auth/password-field";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary w-full">
      {pending ? "Creating account…" : "Create account"}
    </button>
  );
}

// Presentational and hook-free (besides plain useState in PasswordField) so
// it can be rendered and asserted on outside of Next's App Router runtime —
// see tests/auth-forms.test.tsx (AT-IA-001-09).
export function SignupFields({ state }: { state: AuthActionState }) {
  if (state.success) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-green-50 px-4 py-3.5 text-sm text-green-800">
          Almost there — we sent a confirmation link to your email. Click it to
          activate your Baby Steps account.
        </div>
        {state.verificationUrl && (
          <div className="rounded-lg border border-dashed border-chakra-200 bg-chakra-50 px-4 py-3.5 text-sm">
            <p className="font-medium text-chakra-700">
              Local dev mode — no email provider configured:
            </p>
            <Link
              href={state.verificationUrl}
              className="mt-1 block break-all text-green-700 underline hover:text-green-800"
            >
              {state.verificationUrl}
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800"
        >
          {state.error}
        </p>
      )}

      <div>
        <label htmlFor="email" className="field-label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="field-input"
        />
      </div>

      <PasswordField
        id="password"
        name="password"
        label="Password"
        autoComplete="new-password"
        minLength={12}
        helpText="At least 12 characters, with upper-case, lower-case, and a number."
      />

      <PasswordField
        id="confirmPassword"
        name="confirmPassword"
        label="Confirm password"
        autoComplete="new-password"
        minLength={12}
      />

      <div className="space-y-2 text-sm text-chakra-600">
        <label htmlFor="acceptedTerms" className="flex items-start gap-2">
          <input
            id="acceptedTerms"
            name="acceptedTerms"
            type="checkbox"
            required
            className="mt-0.5"
          />
          <span>
            I accept the{" "}
            <Link href="/terms" className="font-medium text-green-700 hover:text-green-800">
              Terms of Service
            </Link>
          </span>
        </label>
        <label htmlFor="acceptedPrivacy" className="flex items-start gap-2">
          <input
            id="acceptedPrivacy"
            name="acceptedPrivacy"
            type="checkbox"
            required
            className="mt-0.5"
          />
          <span>
            I accept the{" "}
            <Link href="/privacy" className="font-medium text-green-700 hover:text-green-800">
              Privacy Policy
            </Link>
          </span>
        </label>
      </div>
    </>
  );
}

export function SignupForm() {
  const [state, formAction] = useFormState(signUpAction, initialAuthState);

  return (
    <form action={formAction} className="space-y-5">
      <SignupFields state={state} />
      {!state.success && (
        <>
          <SubmitButton />
          <p className="text-center text-sm text-chakra-500">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-green-700 hover:text-green-800">
              Log in
            </Link>
          </p>
        </>
      )}
    </form>
  );
}
