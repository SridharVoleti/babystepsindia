"use client";

import { useState } from "react";

const REASON_CODES = [
  { value: "no_longer_supported", label: "No longer supported" },
  { value: "duplicate_registration", label: "Duplicate registration" },
  { value: "replaced_by_new_app", label: "Replaced by a new app" },
  { value: "other", label: "Other" },
];

export function SoftDeleteAppForm({
  appId,
  appKey,
  expectedVersion,
}: {
  appId: string;
  appKey: string;
  expectedVersion: number;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    currentPassword.length > 0 && reasonCode.length > 0 && confirmation === appKey && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/v1/admin/apps/${appId}/soft-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          expectedVersion,
          idempotencyKey: crypto.randomUUID(),
          reasonCode,
          reasonNote: reasonNote || null,
          confirmationAppKey: confirmation,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? body.error ?? "Soft delete failed.");
        setSubmitting(false);
        return;
      }

      window.location.href = `/admin/apps/${appId}`;
    } catch {
      setError("Soft delete failed.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="sd-current-password" className="field-label">
          Current password
        </label>
        <input
          id="sd-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="sd-reason" className="field-label">
          Reason
        </label>
        <select
          id="sd-reason"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className="field-input"
        >
          <option value="">Select a reason…</option>
          {REASON_CODES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="sd-note" className="field-label">
          Note (optional)
        </label>
        <textarea
          id="sd-note"
          rows={2}
          value={reasonNote}
          onChange={(e) => setReasonNote(e.target.value)}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="sd-confirm" className="field-label">
          Type {appKey} to confirm
        </label>
        <input
          id="sd-confirm"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          className="field-input"
        />
      </div>

      <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
        {submitting ? "Deleting…" : "Soft delete this app"}
      </button>
    </form>
  );
}
