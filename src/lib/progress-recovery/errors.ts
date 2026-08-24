// PR-002: one error surface across the recovery write path and its
// routes — same idiom as AppProgressError/ProgressIntegrityError.
export class ProgressRecoveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProgressRecoveryError";
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  PROGRESS_RECOVERY_STALE: 409,
  SESSION_DEVICE_MISMATCH: 403,
  SESSION_RESUME_PROOF_INVALID: 401,
  SESSION_HARD_EXPIRED: 409,
  SESSION_NOT_RESUMABLE: 409,
  PROGRESS_RECOVERY_SEQUENCE_CONFLICT: 409,
  PROGRESS_RECOVERY_CAPSULE_INVALID: 400,
  PROGRESS_MIGRATION_REQUIRED: 409,
  PROGRESS_INTEGRITY_BLOCKED: 409,
  PROGRESS_INTEGRITY_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PROGRESS_RECOVERY_RECEIPT_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
};

export function progressRecoveryErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}
