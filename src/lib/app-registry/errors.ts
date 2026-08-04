// Mirrors the established LearnerCreationError pattern (LP-001/LP-002):
// a typed `code` matching the Alt/Error Flow identifiers from the
// requirement, not a generic message.
export class AppRegistryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AppRegistryError";
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  APP_KEY_INVALID: 400,
  APP_METADATA_INVALID: 400,
  FORBIDDEN_FIELD: 400,
  APP_NOT_READY_FOR_ACTIVATION: 400,
  APP_ICON_NOT_AVAILABLE: 400,
  CONFIRMATION_MISMATCH: 400,
  APP_KEY_ALREADY_EXISTS: 409,
  APP_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  MUTATION_IN_PROGRESS: 409,
  APP_NOT_ACTIVE: 409,
  APP_NOT_FOUND: 404,
};

export function appRegistryErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}
