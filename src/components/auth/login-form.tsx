"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { signInAction } from "@/app/(auth)/actions";
import { initialAuthState, type AuthActionState } from "@/lib/auth-types";
import { PasswordField } from "@/components/auth/password-field";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary w-full">
      {pending ? "Logging in…" : "Log in"}
    </button>
  );
}

// Presentational and hook-free (besides plain useState in PasswordField) so
// it can be rendered and asserted on outside of Next's App Router runtime —
// see tests/auth-forms.test.tsx (AT-IA-001-09).
export function LoginFields({ state }: { state: AuthActionState }) {
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
        autoComplete="current-password"
        rightLabel={
          <Link
            href="/reset-password"
            className="mb-1.5 text-sm font-medium text-green-700 hover:text-green-800"
          >
            Forgot password?
          </Link>
        }
      />
    </>
  );
}

export function LoginForm() {
  const [state, formAction] = useFormState(signInAction, initialAuthState);

  return (
    <form action={formAction} className="space-y-5">
      <LoginFields state={state} />

      <SubmitButton />

      <p className="text-center text-sm text-chakra-500">
        New to Baby Steps?{" "}
        <Link href="/signup" className="font-medium text-green-700 hover:text-green-800">
          Create an account
        </Link>
      </p>
    </form>
  );
}
