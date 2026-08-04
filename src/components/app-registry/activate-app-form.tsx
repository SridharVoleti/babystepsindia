"use client";

import { useState } from "react";

export function ActivateAppForm({ appId, expectedVersion }: { appId: string; expectedVersion: number }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!currentPassword) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/v1/admin/apps/${appId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, expectedVersion, idempotencyKey: crypto.randomUUID() }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(
          body.error === "APP_NOT_READY_FOR_ACTIVATION"
            ? "Short description, icon, category, and owning team must all be set first."
            : body.message ?? body.error ?? "Activation failed.",
        );
        setSubmitting(false);
        return;
      }

      window.location.reload();
    } catch {
      setError("Activation failed.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error}
        </p>
      )}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="activate-password" className="field-label">
            Current password
          </label>
          <input
            id="activate-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="field-input"
          />
        </div>
        <button type="submit" disabled={!currentPassword || submitting} className="btn-primary">
          {submitting ? "Activating…" : "Activate"}
        </button>
      </div>
    </form>
  );
}
