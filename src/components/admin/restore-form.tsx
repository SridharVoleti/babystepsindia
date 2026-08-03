"use client";

import { useState } from "react";

export function RestoreForm() {
  const [parentId, setParentId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canSubmit = parentId.trim().length > 0 && reason.trim().length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await fetch(`/v1/admin/accounts/${encodeURIComponent(parentId.trim())}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? body.error ?? "Restore failed.");
        return;
      }

      setSuccess(true);
      setParentId("");
      setReason("");
    } catch {
      setError("Restore failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-5">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-lg bg-green-50 px-3.5 py-2.5 text-sm text-green-800">
          Account restored. Sessions were not restored — the parent must log
          in again.
        </p>
      )}

      <div>
        <label htmlFor="parentId" className="field-label">
          Parent ID
        </label>
        <input
          id="parentId"
          name="parentId"
          type="text"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          required
          className="field-input"
          placeholder="uuid from the support ticket / account_events log"
        />
      </div>

      <div>
        <label htmlFor="reason" className="field-label">
          Reason (required)
        </label>
        <textarea
          id="reason"
          name="reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          className="field-input"
          placeholder="e.g. deletion confirmed accidental — support ticket #42"
        />
      </div>

      <button type="submit" disabled={!canSubmit} className="btn-primary">
        {submitting ? "Restoring…" : "Restore account"}
      </button>
    </form>
  );
}
