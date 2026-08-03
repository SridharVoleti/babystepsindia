"use client";

import { useState } from "react";
import { PasswordField } from "@/components/auth/password-field";
import { passwordError } from "@/lib/auth/validation";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const formatError = newPassword ? passwordError(newPassword) : null;
  const canSubmit =
    currentPassword.length > 0 &&
    !formatError &&
    newPassword === confirmPassword &&
    !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/v1/account/password/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      setSuccess(true);
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-lg bg-green-50 px-4 py-3.5 text-sm text-green-800">
        Password changed. Use it next time you log in.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error}
        </p>
      )}

      <PasswordField
        id="currentPassword"
        name="currentPassword"
        label="Current password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={setCurrentPassword}
      />

      <PasswordField
        id="newPassword"
        name="newPassword"
        label="New password"
        autoComplete="new-password"
        minLength={12}
        helpText="At least 12 characters, with upper-case, lower-case, and a number."
        value={newPassword}
        onChange={setNewPassword}
      />

      <PasswordField
        id="confirmPassword"
        name="confirmPassword"
        label="Confirm new password"
        autoComplete="new-password"
        minLength={12}
        value={confirmPassword}
        onChange={setConfirmPassword}
      />

      <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
        {submitting ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
