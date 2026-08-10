// PR-004: one error surface across the integrity classifier, write-gate
// callers and the incidents/reconciliation modules — same idiom as
// AppProgressError/ProgressSchemaRegistryError/DeploymentPipelineError.
export class ProgressIntegrityError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProgressIntegrityError";
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  PROGRESS_INTEGRITY_MUTATION_BLOCKED: 409,
  PROGRESS_INTEGRITY_UNREADABLE: 409,
  PROGRESS_INTEGRITY_VERSION_CONFLICT: 409,
  PROGRESS_INTEGRITY_LAUNCH_BLOCKED: 409,
  PROGRESS_INTEGRITY_INCIDENT_NOT_FOUND: 404,
  PROGRESS_INTEGRITY_INCIDENT_VERSION_CONFLICT: 409,
  PROGRESS_INTEGRITY_ACTION_NOT_APPLICABLE: 409,
  PROGRESS_INTEGRITY_RECEIPT_MISMATCH: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  REAUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
};

export function progressIntegrityErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}
