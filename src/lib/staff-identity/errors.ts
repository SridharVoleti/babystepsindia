export class StaffIdentityError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "StaffIdentityError";
  }
}

export function staffIdentityErrorStatus(code: string): number {
  if (["UNAUTHENTICATED", "REAUTHENTICATION_REQUIRED", "REAUTHENTICATION_EXPIRED"].includes(code)) return 401;
  if (code === "FORBIDDEN") return 403;
  if (code === "RESOURCE_NOT_FOUND") return 404;
  if (
    [
      "VERSION_CONFLICT",
      "IDEMPOTENCY_KEY_REUSED",
      "LAST_PLATFORM_ADMINISTRATOR",
      "SELF_ESCALATION_BLOCKED",
      "STAFF_ACCOUNT_REVOKED",
      "STAFF_ACCOUNT_ALREADY_EXISTS",
      "INVITATION_EXPIRED",
    ].includes(code)
  )
    return 409;
  return 400;
}
