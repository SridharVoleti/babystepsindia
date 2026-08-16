// AD-001: separate MFA staff identity, capability-based roles, recent
// reauthentication and immutable audit. Shared constants/types used across
// the whole staff-identity domain (pure, no DB/HTTP).

export const STAFF_ROLE_KEYS = [
  "support_agent",
  "billing_administrator",
  "operations_administrator",
  "platform_administrator",
] as const;

export type StaffRoleKey = (typeof STAFF_ROLE_KEYS)[number];

export type StaffAccountStatus = "invited" | "active" | "suspended" | "revoked";

// Business rule 22.
export const STAFF_IDLE_TIMEOUT_MS = 30 * 60_000;
// Business rule 23.
export const STAFF_ABSOLUTE_SESSION_MS = 8 * 60 * 60_000;
// Business rule 61: current password + fresh passkey UV within 10 minutes.
export const SENSITIVE_REAUTH_WINDOW_MS = 10 * 60_000;
// Business rule 29.
export const INVITATION_TTL_MS = 24 * 60 * 60_000;
// Business rule 16 / GAP-072 precedent.
export const STAFF_CHALLENGE_TTL_MS = 5 * 60_000;
// Business rule 66.
export const REASON_MIN_LENGTH = 20;
export const REASON_MAX_LENGTH = 500;
