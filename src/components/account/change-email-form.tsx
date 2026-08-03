"use client";

import Link from "next/link";
import { useState } from "react";
import { PasswordField } from "@/components/auth/password-field";

export function ChangeEmailForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);

  const canSubmit = currentPassword.length > 0 && newEmail.trim().length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/v1/account/email-change/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newEmail }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      setVerificationUrl(body.verificationUrl ?? null);
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (verificationUrl) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-green-50 px-4 py-3.5 text-sm text-green-800">
          Check {newEmail} for a confirmation link. Your current email stays
          active until you verify — the link expires in 24 hours.
        </div>
        <div className="rounded-lg border border-dashed border-chakra-200 bg-chakra-50 px-4 py-3.5 text-sm">
          <p className="font-medium text-chakra-700">
            Local dev mode — no email provider configured:
          </p>
          <Link
            href={verificationUrl}
            className="mt-1 block break-all text-green-700 underline hover:text-green-800"
          >
            {verificationUrl}
          </Link>
        </div>
        <Link
          href="/account/security"
          className="inline-block text-sm font-medium text-green-700 hover:text-green-800"
        >
          Back to account security
        </Link>
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

      <p className="text-sm text-chakra-500">
        Your current email stays the active login and invoice address until
        the new one is verified — no OTP or SMS, just a confirmation link
        that expires in 24 hours.
      </p>

      <div>
        <label htmlFor="newEmail" className="field-label">
          New email
        </label>
        <input
          id="newEmail"
          name="newEmail"
          type="email"
          autoComplete="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          required
          className="field-input"
        />
      </div>

      <PasswordField
        id="currentPassword"
        name="currentPassword"
        label="Current password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={setCurrentPassword}
      />

      <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
        {submitting ? "Sending…" : "Send verification link"}
      </button>
    </form>
  );
}
