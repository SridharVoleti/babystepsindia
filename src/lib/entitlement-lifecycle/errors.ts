export class EntitlementLifecycleError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EntitlementLifecycleError";
  }
}

export function entitlementLifecycleErrorStatus(code: string): number {
  if (code === "LIFECYCLE_EVENT_NOT_VERIFIED") return 401;
  if (code === "RESOURCE_NOT_FOUND") return 404;
  if (["ENTITLEMENT_LIFECYCLE_VERSION_CONFLICT", "ENTITLEMENT_LIFECYCLE_CONFLICT",
    "IDEMPOTENCY_KEY_REUSED"].includes(code)) return 409;
  return 400;
}
