import { REASON_MAX_LENGTH, REASON_MIN_LENGTH } from "@/lib/staff-identity/contracts";
import { StaffIdentityError } from "@/lib/staff-identity/errors";

// Business rule 66: mandatory, trimmed, 20-500 visible chars, no
// secret/credential-shaped content.
const SECRET_LIKE_PATTERN = /(password|passwd|api[_-]?key|secret|token|bearer)\s*[:=]/i;

export function validateSensitiveReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
    throw new StaffIdentityError("REASON_INVALID");
  }
  if (SECRET_LIKE_PATTERN.test(trimmed)) {
    throw new StaffIdentityError("REASON_INVALID");
  }
  return trimmed;
}
