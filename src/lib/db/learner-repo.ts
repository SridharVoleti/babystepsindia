import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
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

function requireActiveProfile(parentUserId: string): void {
  const profile = getDb().prepare("select account_status from profiles where id = ?").get(parentUserId) as
    | { account_status: string }
    | undefined;
  if (!profile) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
  if (profile.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
  if (profile.account_status === "suspended") throw new LearnerCreationError("ACCOUNT_SUSPENDED");
  if (profile.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");
}

function requestHash(input: Omit<CreateLearnerInput, "idempotencyKey">): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createLearner(parentUserId: string, input: CreateLearnerInput, ageAsOfDate: string) {
  const db = getDb();
  const name = normalizeLearnerName(input.displayName);
  const dateOfBirth = validateDateOfBirth(input.dateOfBirth, ageAsOfDate);
  const avatarId = input.avatarId ?? null;
  const hash = requestHash({
    displayName: name.displayName,
    dateOfBirth,
    ...(avatarId ? { avatarId } : {}),
  });

  const existing = db.prepare(
    "select request_hash, learner_id, status from learner_creation_requests where parent_user_id = ? and idempotency_key = ?",
  ).get(parentUserId, input.idempotencyKey) as
    | { request_hash: string; learner_id: string | null; status: string }
    | undefined;
  if (existing) {
    if (existing.request_hash !== hash) throw new LearnerCreationError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status !== "completed" || !existing.learner_id) {
      throw new LearnerCreationError("LEARNER_CREATION_IN_PROGRESS");
    }
    const row = db.prepare("select * from learners where id = ? and owner_parent_id = ?")
      .get(existing.learner_id, parentUserId) as LearnerRow;
    const profile = db.prepare("select onboarding_status from profiles where id = ?")
      .get(parentUserId) as { onboarding_status: "learner_pending" | "complete" };
    return { learner: view(row, ageAsOfDate), onboardingStatus: profile.onboarding_status, replayed: true };
  }

  const run = db.transaction(() => {
    const profile = db.prepare(
      "select account_status, onboarding_status, locale, timezone from profiles where id = ?",
    ).get(parentUserId) as
      | { account_status: string; onboarding_status: string; locale: string; timezone: string }
      | undefined;
    if (!profile) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
    if (profile.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
    if (profile.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");

    if (avatarId) {
      const avatar = db.prepare("select active from approved_avatars where id = ?").get(avatarId) as
        | { active: number }
        | undefined;
      if (!avatar?.active) throw new LearnerCreationError("AVATAR_NOT_APPROVED");
    }

    db.prepare(
      `insert into learner_creation_requests
       (parent_user_id, idempotency_key, request_hash, status)
       values (?, ?, ?, 'processing')`,
    ).run(parentUserId, input.idempotencyKey, hash);

    const learnerId = randomUUID();
    try {
      db.prepare(
        `insert into learners
         (id, owner_parent_id, display_name, normalized_display_name, date_of_birth, avatar_id, locale, timezone)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        learnerId,
        parentUserId,
        name.displayName,
        name.normalizedDisplayName,
        dateOfBirth,
        avatarId,
        profile.locale,
        profile.timezone,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: learners.owner_parent_id")) {
        throw new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS");
      }
      throw error;
    }

    db.prepare(
      `update profiles set onboarding_status = case
         when onboarding_status = 'learner_pending' then 'complete' else onboarding_status end,
         updated_at = datetime('now') where id = ?`,
    ).run(parentUserId);
    db.prepare(
      "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'learner_created', ?)",
    ).run(randomUUID(), parentUserId, JSON.stringify({ learnerId }));
    db.prepare(
      `update learner_creation_requests set learner_id = ?, status = 'completed', completed_at = datetime('now')
       where parent_user_id = ? and idempotency_key = ?`,
    ).run(learnerId, parentUserId, input.idempotencyKey);

    return db.prepare("select * from learners where id = ?").get(learnerId) as LearnerRow;
  });

  const row = run();
  const profile = db.prepare("select onboarding_status from profiles where id = ?").get(parentUserId) as {
    onboarding_status: "learner_pending" | "complete";
  };
  return { learner: view(row, ageAsOfDate), onboardingStatus: profile.onboarding_status, replayed: false };
}

export function listOwnedLearners(parentUserId: string, ageAsOfDate: string) {
  requireActiveProfile(parentUserId);
  return (getDb().prepare(
    "select * from learners where owner_parent_id = ? order by created_at, id",
  ).all(parentUserId) as LearnerRow[]).map((row) => view(row, ageAsOfDate));
}

export function getOwnedLearner(parentUserId: string, learnerId: string, ageAsOfDate: string) {
  requireActiveProfile(parentUserId);
  const row = getDb().prepare("select * from learners where id = ? and owner_parent_id = ?")
    .get(learnerId, parentUserId) as LearnerRow | undefined;
  if (!row) throw new LearnerCreationError("LEARNER_NOT_FOUND");
  return view(row, ageAsOfDate);
}

export function getParentTimezone(parentUserId: string): string {
  requireActiveProfile(parentUserId);
  const row = getDb().prepare("select timezone from profiles where id = ?").get(parentUserId) as {
    timezone: string;
  };
  return row.timezone;
}

export function listApprovedAvatars(): Array<{ id: string; label: string }> {
  return getDb().prepare("select id, label from approved_avatars where active = 1 order by label, id")
    .all() as Array<{ id: string; label: string }>;
}

export type UpdateLearnerInput = {
  displayName?: string;
  dateOfBirth?: string;
  avatarId?: string | null;
  expectedVersion: number;
  idempotencyKey: string;
};

export function updateLearner(
  parentUserId: string,
  learnerId: string,
  input: UpdateLearnerInput,
  ageAsOfDate: string,
) {
  const db = getDb();
  requireActiveProfile(parentUserId);

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

  const existing = db.prepare(
    `select request_hash, status, response_json from learner_profile_update_requests
     where parent_user_id = ? and learner_id = ? and idempotency_key = ?`,
  ).get(parentUserId, learnerId, input.idempotencyKey) as
    | { request_hash: string; status: string; response_json: string | null }
    | undefined;
  if (existing) {
    if (existing.request_hash !== hash) throw new LearnerCreationError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status !== "completed" || !existing.response_json) {
      throw new LearnerCreationError("LEARNER_UPDATE_IN_PROGRESS");
    }
    return JSON.parse(existing.response_json) as ReturnType<typeof completedUpdateResult>;
  }

  const run = db.transaction(() => {
    const current = db.prepare("select * from learners where id = ? and owner_parent_id = ?")
      .get(learnerId, parentUserId) as LearnerRow | undefined;
    if (!current) throw new LearnerCreationError("LEARNER_NOT_FOUND");

    db.prepare(
      `insert into learner_profile_update_requests
       (parent_user_id, learner_id, idempotency_key, request_hash, expected_version, status)
       values (?, ?, ?, ?, ?, 'processing')`,
    ).run(parentUserId, learnerId, input.idempotencyKey, hash, input.expectedVersion);

    if (current.version !== input.expectedVersion) {
      throw new LearnerCreationError("LEARNER_VERSION_CONFLICT");
    }

    if (hasAvatarId && input.avatarId !== null) {
      const avatar = db.prepare("select active from approved_avatars where id = ?")
        .get(input.avatarId) as { active: number } | undefined;
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
    if (changedFields.length) {
      try {
        db.prepare(
          `update learners set display_name = ?, normalized_display_name = ?, date_of_birth = ?,
           avatar_id = ?, version = version + 1, updated_at = datetime('now')
           where id = ? and owner_parent_id = ? and version = ?`,
        ).run(
          nextDisplayName,
          nextNormalizedName,
          nextDob,
          nextAvatarId,
          learnerId,
          parentUserId,
          input.expectedVersion,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: learners.owner_parent_id")) {
          throw new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS");
        }
        throw error;
      }
      resultRow = db.prepare("select * from learners where id = ?").get(learnerId) as LearnerRow;
      db.prepare(
        "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'learner_profile_changed', ?)",
      ).run(randomUUID(), parentUserId, JSON.stringify({
        learnerId,
        changedFields,
        previousVersion: current.version,
        newVersion: resultRow.version,
      }));
    }

    const result = completedUpdateResult(resultRow, ageAsOfDate, changedFields);
    db.prepare(
      `update learner_profile_update_requests set result_version = ?, status = 'completed',
       response_json = ?, completed_at = datetime('now')
       where parent_user_id = ? and learner_id = ? and idempotency_key = ?`,
    ).run(
      resultRow.version,
      JSON.stringify(result),
      parentUserId,
      learnerId,
      input.idempotencyKey,
    );
    return result;
  });

  return run();
}

function completedUpdateResult(
  row: LearnerRow,
  ageAsOfDate: string,
  changedFields: string[],
) {
  return { learner: view(row, ageAsOfDate), changedFields, noOp: changedFields.length === 0 };
}
