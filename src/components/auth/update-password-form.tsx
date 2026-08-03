"use client";

import { useFormState, useFormStatus } from "react-dom";
import { updatePasswordAction } from "@/app/(auth)/actions";
import { initialAuthState } from "@/lib/auth-types";
import { PasswordField } from "@/components/auth/password-field";

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

      <PasswordField
        id="password"
        name="password"
        label="New password"
        autoComplete="new-password"
        minLength={12}
        helpText="At least 12 characters, with upper-case, lower-case, and a number."
      />

      <SubmitButton />
    </form>
  );
}
