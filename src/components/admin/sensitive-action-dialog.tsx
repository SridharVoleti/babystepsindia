"use client";

import { useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

// AD-001 business rules 60-69, 110: shared confirmation UI for every
// sensitive admin action — shows the exact target/effect, collects the
// mandatory reason, then re-establishes a live two-factor reauth receipt
// (current password + fresh passkey) before calling back so the caller's
// own request lands inside the 10-minute sensitive-reauth window.
export function SensitiveActionDialog({
  title,
  effectSummary,
  confirmLabel,
  onConfirmed,
}: {
  title: string;
  effectSummary: string;
  confirmLabel: string;
  onConfirmed: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length < 20) {
      setError("Give a reason of at least 20 characters.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await completeStaffReauth(password);
      await onConfirmed(reason.trim());
      setOpen(false);
      setReason("");
      setPassword("");
    } catch {
      setError("Reauthentication failed. Confirm your password and try your passkey again.");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        {confirmLabel}
      </button>
    );
  }

  return (
    <div className="card space-y-4 border-saffron-200 p-5">
      <div>
        <h3 className="text-sm font-semibold text-chakra-900">{title}</h3>
        <p className="mt-1 text-sm text-chakra-600">{effectSummary}</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <form onSubmit={confirm} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-chakra-900" htmlFor="sensitive-action-reason">
            Reason (visible in the audit log)
          </label>
          <textarea
            id="sensitive-action-reason"
            required
            minLength={20}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="field-input mt-1 w-full"
            rows={2}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-chakra-900" htmlFor="sensitive-action-password">
            Confirm your current password
          </label>
          <input
            id="sensitive-action-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-input mt-1"
          />
        </div>
        <p className="text-xs text-chakra-500">
          Your passkey will be requested next to complete this two-factor confirmation.
        </p>
        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={pending}>
            {pending ? "Confirming…" : confirmLabel}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
