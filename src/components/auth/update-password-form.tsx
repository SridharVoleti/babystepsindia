"use client";

import { useFormState, useFormStatus } from "react-dom";
import { updatePasswordAction } from "@/app/(auth)/actions";
import { initialAuthState } from "@/lib/auth-types";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary w-full">
      {pending ? "Saving…" : "Set new password"}
    </button>
  );
}

export function UpdatePasswordForm({ token }: { token: string }) {
  const [state, formAction] = useFormState(updatePasswordAction, initialAuthState);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="token" value={token} />

      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800"
        >
          {state.error}
        </p>
      )}

      <div>
        <label htmlFor="password" className="field-label">
          New password
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
    </form>
  );
}
