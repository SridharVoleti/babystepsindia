"use client";

// Temporary simplification (2026-08-27, explicit request): password-only
// sensitive-action reauth, no passkey ceremony. Every existing sensitive
// admin form (activate app, soft-delete, staff role/status changes, etc.)
// calls this exact function, so simplifying it here covers all of them at
// once — see passwordOnlyStaffReauth's own comment (auth-service.ts) for
// how to switch back to the passkey-based ceremony later.
export async function completeStaffReauth(currentPassword: string): Promise<void> {
  const response = await fetch("/v1/admin/auth/reauth", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword }),
  });
  if (!response.ok) throw new Error("STAFF_REAUTH_FAILED");
}
