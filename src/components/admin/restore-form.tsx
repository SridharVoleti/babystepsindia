"use client";

import { useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

// AD-001: account restoration is now gated by Platform Administrator
// capability + a live two-factor reauth receipt (business rules 50, 56,
// 63), where it previously had no reauth step at all — added here to match.
export function RestoreForm() {
  const [parentId, setParentId] = useState("");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("");
  const [caseId, setCaseId] = useState("");
  const [governanceReference, setGovernanceReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canSubmit = parentId.trim().length > 0 && reason.trim().length > 0 && password.length > 0 &&
    expectedVersion.trim().length > 0 && (caseId.trim().length > 0 || governanceReference.trim().length > 0) && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await completeStaffReauth(password);
      const response = await fetch(`/v1/admin/accounts/${encodeURIComponent(parentId.trim())}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason, expectedVersion: Number(expectedVersion), idempotencyKey: crypto.randomUUID(),
          caseId: caseId.trim() || undefined, governanceReference: governanceReference.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? body.error ?? "Restore failed.");
        return;
      }

      setSuccess(true);
      setParentId("");
      setReason("");
      setPassword("");
      setExpectedVersion("");
      setCaseId("");
      setGovernanceReference("");
    } catch {
      setError("Restore failed. Confirm your password and passkey.");
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
        <label htmlFor="expected-version" className="field-label">
          Expected account version
        </label>
        <input
          id="expected-version"
          name="expectedVersion"
          type="number"
          min={1}
          value={expectedVersion}
          onChange={(e) => setExpectedVersion(e.target.value)}
          required
          className="field-input"
          placeholder="version from the account_events log"
        />
      </div>

      <div>
        <label htmlFor="case-id" className="field-label">
          Support case ID (or governance reference below)
        </label>
        <input
          id="case-id"
          name="caseId"
          type="text"
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          className="field-input"
          placeholder="AD-002 support case ID, if this came from a customer interaction"
        />
      </div>

      <div>
        <label htmlFor="governance-reference" className="field-label">
          Governance reference (required if no case ID)
        </label>
        <input
          id="governance-reference"
          name="governanceReference"
          type="text"
          value={governanceReference}
          onChange={(e) => setGovernanceReference(e.target.value)}
          className="field-input"
          placeholder="internal corrective-restoration reference, e.g. incident ticket"
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

      <div>
        <label htmlFor="restore-password" className="field-label">
          Confirm your current password
        </label>
        <input
          id="restore-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="field-input"
        />
        <p className="mt-1 text-xs text-chakra-500">Your passkey will be requested next to complete this confirmation.</p>
      </div>

      <button type="submit" disabled={!canSubmit} className="btn-primary">
        {submitting ? "Restoring…" : "Restore account"}
      </button>
    </form>
  );
}
