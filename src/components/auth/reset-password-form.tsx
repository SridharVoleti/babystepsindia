"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { requestPasswordResetAction } from "@/app/(auth)/actions";
import { initialAuthState } from "@/lib/auth-types";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary w-full">
      {pending ? "Sending link…" : "Send reset link"}
    </button>
  );
}

export function ResetPasswordForm() {
  const [state, formAction] = useFormState(
    requestPasswordResetAction,
    initialAuthState,
  );

  if (state.success) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-green-50 px-4 py-3.5 text-sm text-green-800">
          If an account exists for that email, a password reset link is on its
          way.
        </div>
        {state.resetUrl && (
          <div className="rounded-lg border border-dashed border-chakra-200 bg-chakra-50 px-4 py-3.5 text-sm">
            <p className="font-medium text-chakra-700">
              Local dev mode — no email provider configured:
            </p>
            <Link
              href={state.resetUrl}
              className="mt-1 block break-all text-green-700 underline hover:text-green-800"
            >
              {state.resetUrl}
            </Link>
          </div>
        )}
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

      <SubmitButton />

      <p className="text-center text-sm text-chakra-500">
        <Link href="/login" className="font-medium text-green-700 hover:text-green-800">
          Back to log in
        </Link>
      </p>
    </form>
  );
}
