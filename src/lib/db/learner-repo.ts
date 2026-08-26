import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { calculateAge, normalizeLearnerName, validateDateOfBirth } from "@/lib/learner-profile/validation";

export type CreateLearnerInput = {
  displayName: string;
  dateOfBirth: string;
  avatarId?: string | null;
  idempotencyKey: string;
};

type LearnerRow = {
  id: string;
  owner_parent_id: string;
  display_name: string;
  normalized_display_name: string;
  date_of_birth: string;
  avatar_id: string | null;
  version: number;
  locale: string;
  timezone: string;
  created_at: string;
  updated_at: string;
};

export class LearnerCreationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LearnerCreationError";
  }
}

function view(row: LearnerRow, ageAsOfDate: string) {
  return {
    id: row.id,
    ownerParentId: row.owner_parent_id,
    displayName: row.display_name,
    dateOfBirth: row.date_of_birth,
    ...calculateAge(row.date_of_birth, ageAsOfDate),
    ageAsOfDate,
    avatarId: row.avatar_id,
    version: row.version,
    locale: row.locale,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireActiveProfile(parentUserId: string): Promise<void> {
  const profile = await resolveDbClient().get<{ account_status: string }>(
    "select account_status from profiles where id = ?", [parentUserId]);
  if (!profile) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
  if (profile.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
  if (profile.account_status === "suspended") throw new LearnerCreationError("ACCOUNT_SUSPENDED");
  if (profile.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");
}

function requestHash(input: Omit<CreateLearnerInput, "idempotencyKey">): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function createLearner(parentUserId: string, input: CreateLearnerInput, ageAsOfDate: string) {
  const db = resolveDbClient();
  const name = normalizeLearnerName(input.displayName);
  const dateOfBirth = validateDateOfBirth(input.dateOfBirth, ageAsOfDate);
  const avatarId = input.avatarId ?? null;
  const hash = requestHash({
    displayName: name.displayName,
    dateOfBirth,
    ...(avatarId ? { avatarId } : {}),
  });

  const existing = await db.get<{ request_hash: string; learner_id: string | null; status: string }>(
    "select request_hash, learner_id, status from learner_creation_requests where parent_user_id = ? and idempotency_key = ?",
    [parentUserId, input.idempotencyKey],
  );
  if (existing) {
    if (existing.request_hash !== hash) throw new LearnerCreationError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status !== "completed" || !existing.learner_id) {
      throw new LearnerCreationError("LEARNER_CREATION_IN_PROGRESS");
    }
    const row = (await db.get<LearnerRow>(
      "select * from learners where id = ? and owner_parent_id = ?", [existing.learner_id, parentUserId]))!;
    const profile = (await db.get<{ onboarding_status: "learner_pending" | "complete" }>(
      "select onboarding_status from profiles where id = ?", [parentUserId]))!;
    return { learner: view(row, ageAsOfDate), onboardingStatus: profile.onboarding_status };
  }

  const row = await resolveDbClient().transaction(async (tx: DbClient) => {
    const profile = await tx.get<{ account_status: string; onboarding_status: string; locale: string; timezone: string }>(
      "select account_status, onboarding_status, locale, timezone from profiles where id = ?", [parentUserId]);
    if (!profile) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
    if (profile.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
    if (profile.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");

    if (avatarId) {
      const avatar = await tx.get<{ active: number }>(
        "select active from approved_avatars where id = ?", [avatarId]);
      if (!avatar?.active) throw new LearnerCreationError("AVATAR_NOT_APPROVED");
    }

    await tx.run(
      `insert into learner_creation_requests
       (parent_user_id, idempotency_key, request_hash, status)
       values (?, ?, ?, 'processing')`,
      [parentUserId, input.idempotencyKey, hash],
    );

    const learnerId = randomUUID();
    try {
      await tx.run(
        `insert into learners
         (id, owner_parent_id, display_name, normalized_display_name, date_of_birth, avatar_id, locale, timezone)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          learnerId,
          parentUserId,
          name.displayName,
          name.normalizedDisplayName,
          dateOfBirth,
          avatarId,
          profile.locale,
          profile.timezone,
        ],
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: learners.owner_parent_id")) {
        throw new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS");
      }
      throw error;
    }

    const now = new Date().toISOString();
    await tx.run(
      `update profiles set onboarding_status = case
         when onboarding_status = 'learner_pending' then 'complete' else onboarding_status end,
         updated_at = ? where id = ?`,
      [now, parentUserId],
    );
    await tx.run(
      "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'learner_created', ?)",
      [randomUUID(), parentUserId, JSON.stringify({ learnerId })],
    );
    await tx.run(
      `update learner_creation_requests set learner_id = ?, status = 'completed', completed_at = ?
       where parent_user_id = ? and idempotency_key = ?`,
      [learnerId, now, parentUserId, input.idempotencyKey],
    );

    return (await tx.get<LearnerRow>("select * from learners where id = ?", [learnerId]))!;
  });

  const profile = (await db.get<{ onboarding_status: "learner_pending" | "complete" }>(
    "select onboarding_status from profiles where id = ?", [parentUserId]))!;
  return { learner: view(row, ageAsOfDate), onboardingStatus: profile.onboarding_status };
}

export async function listOwnedLearners(parentUserId: string, ageAsOfDate: string) {
  await requireActiveProfile(parentUserId);
  const rows = await resolveDbClient().all<LearnerRow>(
    "select * from learners where owner_parent_id = ? order by created_at, id", [parentUserId]);
  return rows.map((row) => view(row, ageAsOfDate));
}

export async function getOwnedLearner(parentUserId: string, learnerId: string, ageAsOfDate: string) {
  await requireActiveProfile(parentUserId);
  const row = await resolveDbClient().get<LearnerRow>(
    "select * from learners where id = ? and owner_parent_id = ?", [learnerId, parentUserId]);
  if (!row) throw new LearnerCreationError("LEARNER_NOT_FOUND");
  return view(row, ageAsOfDate);
}

export async function getParentTimezone(parentUserId: string): Promise<string> {
  await requireActiveProfile(parentUserId);
  const row = (await resolveDbClient().get<{ timezone: string }>(
    "select timezone from profiles where id = ?", [parentUserId]))!;
  return row.timezone;
}

export async function listApprovedAvatars(): Promise<Array<{ id: string; label: string }>> {
  return resolveDbClient().all<{ id: string; label: string }>(
    "select id, label from approved_avatars where active = true order by label, id");
}

export type UpdateLearnerInput = {
  displayName?: string;
  dateOfBirth?: string;
  avatarId?: string | null;
  expectedVersion: number;
  idempotencyKey: string;
};

export async function updateLearner(
  parentUserId: string,
  learnerId: string,
  input: UpdateLearnerInput,
  ageAsOfDate: string,
) {
  const db = resolveDbClient();
  await requireActiveProfile(parentUserId);

  const hasDisplayName = Object.prototype.hasOwnProperty.call(input, "displayName");
  const hasDateOfBirth = Object.prototype.hasOwnProperty.call(input, "dateOfBirth");
  const hasAvatarId = Object.prototype.hasOwnProperty.call(input, "avatarId");
  if (!hasDisplayName && !hasDateOfBirth && !hasAvatarId) {
    throw new LearnerCreationError("NO_CHANGES_SUBMITTED");
  }

  const cleanedName = hasDisplayName ? normalizeLearnerName(input.displayName!) : null;
  const cleanedDob = hasDateOfBirth
    ? validateDateOfBirth(input.dateOfBirth!, ageAsOfDate)
    : null;
  const canonical = {
    ...(cleanedName ? { displayName: cleanedName.displayName } : {}),
    ...(cleanedDob ? { dateOfBirth: cleanedDob } : {}),
    ...(hasAvatarId ? { avatarId: input.avatarId ?? null } : {}),
    expectedVersion: input.expectedVersion,
  };
  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");

  const existing = await db.get<{ request_hash: string; status: string; response_json: string | null }>(
    `select request_hash, status, response_json from learner_profile_update_requests
     where parent_user_id = ? and learner_id = ? and idempotency_key = ?`,
    [parentUserId, learnerId, input.idempotencyKey],
  );
  if (existing) {
    if (existing.request_hash !== hash) throw new LearnerCreationError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status !== "completed" || !existing.response_json) {
      throw new LearnerCreationError("LEARNER_UPDATE_IN_PROGRESS");
    }
    return JSON.parse(existing.response_json) as ReturnType<typeof completedUpdateResult>;
  }

  return resolveDbClient().transaction(async (tx: DbClient) => {
    const current = await tx.get<LearnerRow>(
      "select * from learners where id = ? and owner_parent_id = ?", [learnerId, parentUserId]);
    if (!current) throw new LearnerCreationError("LEARNER_NOT_FOUND");

    await tx.run(
      `insert into learner_profile_update_requests
       (parent_user_id, learner_id, idempotency_key, request_hash, expected_version, status)
       values (?, ?, ?, ?, ?, 'processing')`,
      [parentUserId, learnerId, input.idempotencyKey, hash, input.expectedVersion],
    );

    if (current.version !== input.expectedVersion) {
      throw new LearnerCreationError("LEARNER_VERSION_CONFLICT");
    }

    if (hasAvatarId && input.avatarId != null) {
      const avatar = await tx.get<{ active: number }>(
        "select active from approved_avatars where id = ?", [input.avatarId]);
      if (!avatar?.active) throw new LearnerCreationError("AVATAR_NOT_AVAILABLE");
    }

    const nextDisplayName = cleanedName?.displayName ?? current.display_name;
    const nextNormalizedName = cleanedName?.normalizedDisplayName ?? current.normalized_display_name;
    const nextDob = cleanedDob ?? current.date_of_birth;
    const nextAvatarId = hasAvatarId ? input.avatarId ?? null : current.avatar_id;
    const changedFields: string[] = [];
    if (nextDisplayName !== current.display_name) changedFields.push("displayName");
    if (nextDob !== current.date_of_birth) changedFields.push("dateOfBirth");
    if (nextAvatarId !== current.avatar_id) changedFields.push("avatarId");

    let resultRow = current;
    const now = new Date().toISOString();
    if (changedFields.length) {
      try {
        await tx.run(
          `update learners set display_name = ?, normalized_display_name = ?, date_of_birth = ?,
           avatar_id = ?, version = version + 1, updated_at = ?
           where id = ? and owner_parent_id = ? and version = ?`,
          [
            nextDisplayName,
            nextNormalizedName,
            nextDob,
            nextAvatarId,
            now,
            learnerId,
            parentUserId,
            input.expectedVersion,
          ],
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: learners.owner_parent_id")) {
          throw new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS");
        }
        throw error;
      }
      resultRow = (await tx.get<LearnerRow>("select * from learners where id = ?", [learnerId]))!;
      await tx.run(
        "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'learner_profile_changed', ?)",
        [randomUUID(), parentUserId, JSON.stringify({
          learnerId,
          changedFields,
          previousVersion: current.version,
          newVersion: resultRow.version,
        })],
      );
    }

    const result = completedUpdateResult(resultRow, ageAsOfDate, changedFields);
    await tx.run(
      `update learner_profile_update_requests set result_version = ?, status = 'completed',
       response_json = ?, completed_at = ?
       where parent_user_id = ? and learner_id = ? and idempotency_key = ?`,
      [
        resultRow.version,
        JSON.stringify(result),
        now,
        parentUserId,
        learnerId,
        input.idempotencyKey,
      ],
    );
    return result;
  });
}

function completedUpdateResult(
  row: LearnerRow,
  ageAsOfDate: string,
  changedFields: string[],
) {
  return { learner: view(row, ageAsOfDate), changedFields, noOp: changedFields.length === 0 };
}
