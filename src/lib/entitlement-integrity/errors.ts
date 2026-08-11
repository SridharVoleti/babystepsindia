export class EntitlementIntegrityError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EntitlementIntegrityError";
  }
}

export function entitlementIntegrityErrorStatus(code: string): number {
  if (code === "RESOURCE_NOT_FOUND" || code === "ENTITLEMENT_INTEGRITY_INCIDENT_NOT_FOUND") return 404;
  if (["ENTITLEMENT_INTEGRITY_CONFLICT", "ENTITLEMENT_INTEGRITY_VERSION_CONFLICT",
    "IDEMPOTENCY_KEY_REUSED", "ENTITLEMENT_REPAIR_IN_PROGRESS"].includes(code)) return 409;
  return 400;
}
