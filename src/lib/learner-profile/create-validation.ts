import type { CreateLearnerInput } from "@/lib/db/learner-repo";

const ALLOWED = new Set(["displayName", "dateOfBirth", "avatarId", "idempotencyKey"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LearnerCreateValidation = { ok: true; value: CreateLearnerInput } | { ok: false; code: string };

export function validateLearnerCreateBody(body: unknown): LearnerCreateValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "INVALID_BODY" };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !ALLOWED.has(key))) return { ok: false, code: "UNEXPECTED_FIELD" };
  if (typeof record.displayName !== "string") return { ok: false, code: "DISPLAY_NAME_REQUIRED" };
  if (typeof record.dateOfBirth !== "string") return { ok: false, code: "DATE_OF_BIRTH_INVALID" };
  if (typeof record.idempotencyKey !== "string" || !UUID.test(record.idempotencyKey)) return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  if (record.avatarId !== undefined && record.avatarId !== null && typeof record.avatarId !== "string") return { ok: false, code: "AVATAR_INVALID" };
  return { ok: true, value: { displayName: record.displayName, dateOfBirth: record.dateOfBirth,
    idempotencyKey: record.idempotencyKey, ...(record.avatarId !== undefined ? { avatarId: record.avatarId as string | null } : {}) } };
}
