"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { signInAction } from "@/app/(auth)/actions";
import { initialAuthState } from "@/lib/auth-types";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary w-full">
      {pending ? "Logging in…" : "Log in"}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useFormState(signInAction, initialAuthState);

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

      <div>
        <div className="flex items-center justify-between">
          <label htmlFor="password" className="field-label">
            Password
          </label>
          <Link
            href="/reset-password"
            className="mb-1.5 text-sm font-medium text-green-700 hover:text-green-800"
          >
            Forgot password?
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="field-input"
        />
      </div>

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
