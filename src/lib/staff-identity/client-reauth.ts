"use client";

import { startAuthentication } from "@simplewebauthn/browser";

// AD-001: shared client-side "prove current password + fresh passkey"
// ceremony every existing sensitive admin form now needs before its own
// mutation call — replaces the old per-call password-only reauth. Throws
// on any failure; callers should catch and show their own error message.
export async function completeStaffReauth(currentPassword: string): Promise<void> {
  const beginResponse = await fetch("/v1/admin/auth/passkey/assertion-options", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword }),
  });
  if (!beginResponse.ok) throw new Error("STAFF_REAUTH_FAILED");
  const { pendingToken, challengeId, options } = await beginResponse.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assertion = await startAuthentication({ optionsJSON: options as any });
  const verifyResponse = await fetch("/v1/admin/auth/passkey/verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingToken, challengeId, response: assertion }),
  });
  if (!verifyResponse.ok) throw new Error("STAFF_REAUTH_FAILED");
}
