"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { signUpAction } from "@/app/(auth)/actions";
import { initialAuthState } from "@/lib/auth-types";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary w-full">
      {pending ? "Creating account…" : "Create account"}
    </button>
  );
}

export function SignupForm() {
  const [state, formAction] = useFormState(signUpAction, initialAuthState);

  if (state.success) {
    return (
      <div className="rounded-lg bg-green-50 px-4 py-3.5 text-sm text-green-800">
        Almost there — we sent a confirmation link to your email. Click it to
        activate your Baby Steps account.
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800"
        >
          {state.error}
        </p>
      )}

      <div>
        <label htmlFor="displayName" className="field-label">
          Name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          autoComplete="name"
          className="field-input"
        />
      </div>

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

      <div>
        <label htmlFor="password" className="field-label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className="field-input"
        />
        <p className="mt-1.5 text-xs text-chakra-400">At least 8 characters.</p>
      </div>

      <SubmitButton />

      <p className="text-center text-sm text-chakra-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-green-700 hover:text-green-800">
          Log in
        </Link>
      </p>
    </form>
  );
}
