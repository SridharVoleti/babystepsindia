import type { UpdateLearnerInput } from "@/lib/db/learner-repo";

const ALLOWED_FIELDS = new Set([
  "displayName", "dateOfBirth", "avatarId", "expectedVersion", "idempotencyKey",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ProtectedFieldCategory = "identity" | "ownership" | "creation" | "version" |
  "educational_state" | "commercial_state" | "session_state" | "cadence_state" | "unknown";
const PROTECTED_FIELD_CATEGORIES: Record<string, ProtectedFieldCategory> = {
  id: "identity", learnerId: "identity",
  ownerParentId: "ownership", owner_parent_id: "ownership",
  createdAt: "creation", created_at: "creation", version: "version",
  progress: "educational_state", subscription: "commercial_state", entitlement: "commercial_state",
  session: "session_state", cadence: "cadence_state",
};

export type LearnerUpdateValidation =
  | { ok: true; value: UpdateLearnerInput }
  | { ok: false; code: string };

export function validateLearnerUpdateBody(body: unknown): LearnerUpdateValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((field) => !ALLOWED_FIELDS.has(field))) {
    return { ok: false, code: "FORBIDDEN_FIELD" };
  }
  const hasName = Object.prototype.hasOwnProperty.call(record, "displayName");
  const hasDob = Object.prototype.hasOwnProperty.call(record, "dateOfBirth");
  const hasAvatar = Object.prototype.hasOwnProperty.call(record, "avatarId");
  if (!hasName && !hasDob && !hasAvatar) return { ok: false, code: "NO_CHANGES_SUBMITTED" };
  if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) < 1) {
    return { ok: false, code: "EXPECTED_VERSION_INVALID" };
  }
  if (typeof record.idempotencyKey !== "string" || !UUID.test(record.idempotencyKey)) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }
  if (hasName && typeof record.displayName !== "string") {
    return { ok: false, code: "DISPLAY_NAME_INVALID" };
  }
  if (hasDob && typeof record.dateOfBirth !== "string") {
    return { ok: false, code: "DATE_OF_BIRTH_INVALID" };
  }
  if (hasAvatar && record.avatarId !== null && typeof record.avatarId !== "string") {
    return { ok: false, code: "AVATAR_NOT_AVAILABLE" };
  }
  return {
    ok: true,
    value: {
      ...(hasName ? { displayName: record.displayName as string } : {}),
      ...(hasDob ? { dateOfBirth: record.dateOfBirth as string } : {}),
      ...(hasAvatar ? { avatarId: record.avatarId as string | null } : {}),
      expectedVersion: record.expectedVersion as number,
      idempotencyKey: record.idempotencyKey,
    },
  };
}

export function protectedFieldCategory(body: unknown): ProtectedFieldCategory {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "unknown";
  const field = Object.keys(body as Record<string, unknown>).find(candidate => !ALLOWED_FIELDS.has(candidate));
  return field ? PROTECTED_FIELD_CATEGORIES[field] ?? "unknown" : "unknown";
}
