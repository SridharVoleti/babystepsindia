"use client";

import { useState } from "react";

export function DeleteAccountForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = currentPassword.length > 0 && confirmation === "DELETE" && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/v1/account/soft-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, confirmation }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error}
        </p>
      )}

      <div className="rounded-lg border border-saffron-200 bg-saffron-50 px-4 py-3.5 text-sm text-saffron-800">
        Your account, learner profiles, progress, billing history, and consent
        records are all retained — nothing is erased. Deleting only blocks
        access. Restoring an account later requires contacting support.
      </div>

      <div>
        <label htmlFor="currentPassword" className="field-label">
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="confirmation" className="field-label">
          Type DELETE to confirm
        </label>
        <input
          id="confirmation"
          name="confirmation"
          type="text"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          required
          className="field-input"
        />
      </div>

      <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
        {submitting ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}
