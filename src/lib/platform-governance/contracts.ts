export class PlatformGovernanceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PlatformGovernanceError";
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  PARENT_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RECOVERY_SESSION_EXPIRED: 409,
  RECOVERY_SESSION_NOT_FOUND: 409,
  OTHER_ADMINISTRATOR_AVAILABLE: 409,
  RECOVERY_CODE_INVALID: 409,
  ACCOUNT_NOT_ELIGIBLE: 409,
  SELF_RECOVERY_BLOCKED: 400,
  INVALID_REQUEST: 400,
  INVALID_REASON: 400,
  RATE_LIMITED: 429,
};

export function platformGovernanceErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}

// AD-005 rules 39, 41: a normal recovery session outlives a handful of
// short admin-side requests but is still bounded and single-use.
export const RECOVERY_SESSION_TTL_MS = 30 * 60_000;

// Rule 54: never generate fewer than two codes at once, so one loss/use
// doesn't immediately remove all recovery capability.
export const RECOVERY_CODE_BATCH_SIZE = 5;

export function isValidGovernanceReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 20 && trimmed.length <= 500;
}
