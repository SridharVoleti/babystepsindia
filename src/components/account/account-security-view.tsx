"use client";

import Link from "next/link";
import { useState } from "react";
import type { SecurityView } from "@/lib/db/account-security-repo";

// Plain useState + fetch — no useRouter/useFormState, same reasoning as
// the IA-002 onboarding form (see parent-onboarding-form.tsx).
export function AccountSecurityView({ initialView }: { initialView: SecurityView }) {
  const [pending, setPending] = useState(initialView.pendingEmailChange);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/v1/account/email-change/resend", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Couldn't resend the verification link.");
        return;
      }
      setPending((prev) => (prev ? { ...prev, expiresAt: body.expiresAt } : prev));
      setVerificationUrl(body.verificationUrl ?? null);
    } catch {
      setError("Couldn't resend the verification link.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/v1/account/email-change/cancel", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.message ?? "Couldn't cancel the pending change.");
        return;
      }
      setPending(null);
      setVerificationUrl(null);
    } catch {
      setError("Couldn't cancel the pending change.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card divide-y divide-chakra-100">
        <div className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">
            Current email
          </p>
          <p className="mt-1 text-chakra-900">{initialView.email}</p>
        </div>

        {pending && (
          <div className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">
              Pending email change
            </p>
            <p className="mt-1 text-chakra-900">{pending.newEmail}</p>
            <p className="mt-1 text-xs text-chakra-400">
              Expires {new Date(pending.expiresAt).toLocaleString()}. The email above stays
              active until this is verified.
            </p>

            {error && (
              <p role="alert" className="mt-3 text-sm text-saffron-700">
                {error}
              </p>
            )}

            {verificationUrl && (
              <div className="mt-3 rounded-lg border border-dashed border-chakra-200 bg-chakra-50 px-4 py-3.5 text-sm">
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
            )}

            <div className="mt-3 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={handleResend}
                className="btn-secondary"
              >
                Resend
              </button>
              <button type="button" disabled={busy} onClick={handleCancel} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card divide-y divide-chakra-100">
        <Link href="/account/security/password" className="block p-5 hover:bg-chakra-50">
          <p className="font-medium text-chakra-900">Change password</p>
          <p className="mt-0.5 text-sm text-chakra-500">Requires your current password.</p>
        </Link>
        <Link href="/account/security/email" className="block p-5 hover:bg-chakra-50">
          <p className="font-medium text-chakra-900">Change email</p>
          <p className="mt-0.5 text-sm text-chakra-500">
            The new address stays inactive until verified.
          </p>
        </Link>
        <Link href="/account/delete" className="block p-5 hover:bg-chakra-50">
          <p className="font-medium text-saffron-800">Delete account</p>
          <p className="mt-0.5 text-sm text-chakra-500">
            Deactivates your account — your data is retained, not erased.
          </p>
        </Link>
      </div>
    </div>
  );
}
