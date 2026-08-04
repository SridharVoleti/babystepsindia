// Mirrors the established LearnerCreationError pattern (LP-001/LP-002):
// a typed `code` matching the Alt/Error Flow identifiers from the
// requirement, not a generic message.
export class AppRegistryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AppRegistryError";
  }
}
