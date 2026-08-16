import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { SENSITIVE_REAUTH_WINDOW_MS } from "@/lib/staff-identity/contracts";
import { StaffIdentityError } from "@/lib/staff-identity/errors";

// Called once the passkey assertion for purpose="reauth" has verified
// (auth-service's beginStaffReauth already re-verified the password —
// business rule 61's "both current password and a fresh passkey
// challenge"). Writes the 10-minute elevation receipt; does NOT touch
// the staff session's own expiry (business rule 69).
export function recordReauthReceipt(input: { staffSessionId: string; staffAccountId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const validUntil = new Date(now.getTime() + SENSITIVE_REAUTH_WINDOW_MS);
  getDb()
    .prepare(
      `insert into staff_reauth_receipts (id,staff_session_id,staff_account_id,reauth_at,valid_until,factors_json)
       values (?,?,?,?,?,?)`,
    )
    .run(randomUUID(), input.staffSessionId, input.staffAccountId, now.toISOString(), validUntil.toISOString(),
      JSON.stringify({ password: true, passkey: true }));
  return { validUntil: validUntil.toISOString() };
}

// Business rules 60, 63, 67-68: every sensitive mutation fails closed
// unless a live (<=10-minute) two-factor reauth receipt exists for this
// exact session. Checked fresh on every sensitive call — a missing/
// expired receipt creates no domain mutation.
export function requireSensitiveReauth(input: {
  staffSessionId: string;
  staffAccountId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const receipt = getDb()
    .prepare(
      `select id from staff_reauth_receipts where staff_session_id=? and staff_account_id=? and valid_until>?
       order by reauth_at desc limit 1`,
    )
    .get(input.staffSessionId, input.staffAccountId, now.toISOString());
  if (!receipt) throw new StaffIdentityError("REAUTHENTICATION_REQUIRED");
}

// Boolean, non-throwing variant for page-render checks (e.g. showing a
// "reauthenticate" prompt instead of a form) rather than an API guard.
export function hasLiveReauthReceipt(input: { staffSessionId: string; staffAccountId: string; now?: Date }): boolean {
  try {
    requireSensitiveReauth(input);
    return true;
  } catch {
    return false;
  }
}
