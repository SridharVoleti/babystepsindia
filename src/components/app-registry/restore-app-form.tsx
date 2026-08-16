"use client";

import { useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

export function RestoreAppForm({ appId, expectedVersion }: { appId: string; expectedVersion: number }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = currentPassword.length > 0 && reasonCode.trim().length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      await completeStaffReauth(currentPassword);
      const response = await fetch(`/v1/admin/apps/${appId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion, reasonCode, idempotencyKey: crypto.randomUUID() }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? body.error ?? "Restore failed.");
        setSubmitting(false);
        return;
      }

      window.location.reload();
    } catch {
      setError("Restore failed.");
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
      <p className="text-sm text-chakra-500">
        Restoring returns this app to draft — it must be activated again
        separately.
      </p>
      <div>
        <label htmlFor="restore-password" className="field-label">
          Current password
        </label>
        <input
          id="restore-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="field-input"
        />
      </div>
      <div>
        <label htmlFor="restore-reason" className="field-label">
          Reason
        </label>
        <input
          id="restore-reason"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          placeholder="e.g. deleted in error"
          className="field-input"
        />
      </div>
      <button type="submit" disabled={!canSubmit} className="btn-primary">
        {submitting ? "Restoring…" : "Restore to draft"}
      </button>
    </form>
  );
}
