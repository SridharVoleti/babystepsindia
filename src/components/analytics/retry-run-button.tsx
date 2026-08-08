"use client";

import { useState } from "react";

export function RetryRunButton({ activityDate }: { activityDate: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/v1/admin/analytics/runs/${activityDate}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? body.error ?? "Retry failed.");
        setSubmitting(false);
        return;
      }
      window.location.href = "/admin/analytics/runs";
    } catch {
      setError("Retry failed.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error && <p role="alert" className="text-xs text-saffron-800">{error}</p>}
      <label htmlFor={`retry-password-${activityDate}`} className="text-xs font-medium text-chakra-600">
        Current password
      </label>
      <input
        id={`retry-password-${activityDate}`}
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        disabled={submitting}
        className="field-input max-w-48 py-1.5 text-xs"
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={!currentPassword || submitting}
        className="btn-secondary py-1 text-xs"
      >
        {submitting ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
