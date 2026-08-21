import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { calculateAge, normalizeLearnerName, validateDateOfBirth } from "@/lib/learner-profile/validation";
import { LearnerCreationError, type CreateLearnerInput, type UpdateLearnerInput } from "@/lib/db/learner-repo";

type Row = { id: string; owner_parent_id: string; display_name: string; normalized_display_name: string;
  date_of_birth: string; avatar_id: string | null; version: number; locale: string; timezone: string;
  created_at: string; updated_at: string };
const ROW_COLUMNS = "id,owner_parent_id,display_name,normalized_display_name,date_of_birth::text as date_of_birth,avatar_id,version,locale,timezone,created_at,updated_at";
const dateOnly = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const view = (row: Row, asOf: string) => ({ id: row.id, ownerParentId: row.owner_parent_id,
  displayName: row.display_name, dateOfBirth: dateOnly(row.date_of_birth),
  ...calculateAge(dateOnly(row.date_of_birth), asOf), ageAsOfDate: asOf, avatarId: row.avatar_id,
  version: Number(row.version), locale: row.locale, timezone: row.timezone,
  createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });

async function profile(parentUserId: string) {
  const row = await resolveDbClient().get<{ account_status: string; onboarding_status: string; locale: string; timezone: string }>(
    "select account_status,onboarding_status,locale,timezone from profiles where id=?", [parentUserId]);
  if (!row) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
  if (row.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
  if (row.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");
  return row;
}

export async function createLearner(parentUserId: string, input: CreateLearnerInput, ageAsOfDate: string) {
  const name = normalizeLearnerName(input.displayName), dob = validateDateOfBirth(input.dateOfBirth, ageAsOfDate);
  const avatarId = input.avatarId ?? null;
  const hash = createHash("sha256").update(JSON.stringify({ displayName: name.displayName, dateOfBirth: dob,
    ...(avatarId ? { avatarId } : {}) })).digest("hex");
  const db = resolveDbClient();
  return db.transaction(async tx => {
    const owner = await tx.get<{ account_status: string; onboarding_status: string; locale: string; timezone: string }>(
      "select account_status,onboarding_status,locale,timezone from profiles where id=? for update", [parentUserId]);
    if (!owner) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
    if (owner.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
    if (owner.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");
    const existing = await tx.get<{ request_hash: string; learner_id: string | null; status: string }>(
      "select request_hash,learner_id,status from learner_creation_requests where parent_user_id=? and idempotency_key=?",
      [parentUserId, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== hash) throw new LearnerCreationError("IDEMPOTENCY_KEY_REUSED");
      if (existing.status !== "completed" || !existing.learner_id) throw new LearnerCreationError("LEARNER_CREATION_IN_PROGRESS");
      const row = await tx.get<Row>(`select ${ROW_COLUMNS} from learners where id=? and owner_parent_id=?`, [existing.learner_id, parentUserId]);
      return { learner: view(row!, ageAsOfDate), onboardingStatus: owner.onboarding_status, replayed: true };
    }
    if (avatarId) {
      const avatar = await tx.get<{ active: boolean }>("select active from approved_avatars where id=?", [avatarId]);
      if (!avatar?.active) throw new LearnerCreationError("AVATAR_NOT_APPROVED");
    }
    await tx.run("insert into learner_creation_requests(parent_user_id,idempotency_key,request_hash,status) values(?,?,?,'processing')",
      [parentUserId, input.idempotencyKey, hash]);
    const learnerId = randomUUID();
    try { await tx.run(`insert into learners(id,owner_parent_id,display_name,normalized_display_name,date_of_birth,avatar_id,locale,timezone)
      values(?,?,?,?,?,?,?,?)`, [learnerId, parentUserId, name.displayName, name.normalizedDisplayName, dob, avatarId, owner.locale, owner.timezone]); }
    catch (error) { if (error instanceof Error && /unique|duplicate/i.test(error.message)) throw new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS"); throw error; }
    const now = new Date().toISOString();
    await tx.run("update profiles set onboarding_status=case when onboarding_status='learner_pending' then 'complete' else onboarding_status end,updated_at=? where id=?", [now, parentUserId]);
    await tx.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_created',?)", [randomUUID(), parentUserId, JSON.stringify({ learnerId })]);
    await tx.run("update learner_creation_requests set learner_id=?,status='completed',completed_at=? where parent_user_id=? and idempotency_key=?",
      [learnerId, now, parentUserId, input.idempotencyKey]);
    const row = await tx.get<Row>(`select ${ROW_COLUMNS} from learners where id=?`, [learnerId]);
    return { learner: view(row!, ageAsOfDate), onboardingStatus: "complete", replayed: false };
  });
}

export async function listOwnedLearners(parentUserId: string, asOf: string) {
  await profile(parentUserId); return (await resolveDbClient().all<Row>(
    `select ${ROW_COLUMNS} from learners where owner_parent_id=? order by created_at,id`, [parentUserId])).map(row => view(row, asOf));
}
export async function getOwnedLearner(parentUserId: string, learnerId: string, asOf: string) {
  await profile(parentUserId); const row = await resolveDbClient().get<Row>(
    `select ${ROW_COLUMNS} from learners where id=? and owner_parent_id=?`, [learnerId, parentUserId]);
  if (!row) throw new LearnerCreationError("LEARNER_NOT_FOUND"); return view(row, asOf);
}
export async function getParentTimezone(parentUserId: string) { return (await profile(parentUserId)).timezone; }

export async function updateLearner(parentUserId: string, learnerId: string, input: UpdateLearnerInput, ageAsOfDate: string) {
  const hasName = Object.prototype.hasOwnProperty.call(input, "displayName");
  const hasDob = Object.prototype.hasOwnProperty.call(input, "dateOfBirth");
  const hasAvatar = Object.prototype.hasOwnProperty.call(input, "avatarId");
  if (!hasName && !hasDob && !hasAvatar) throw new LearnerCreationError("NO_CHANGES_SUBMITTED");
  const name = hasName ? normalizeLearnerName(input.displayName!) : null;
  const dob = hasDob ? validateDateOfBirth(input.dateOfBirth!, ageAsOfDate) : null;
  const canonical = { ...(name ? { displayName: name.displayName } : {}), ...(dob ? { dateOfBirth: dob } : {}),
    ...(hasAvatar ? { avatarId: input.avatarId ?? null } : {}), expectedVersion: input.expectedVersion };
  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");

  return resolveDbClient().transaction(async tx => {
    const owner = await tx.get<{ account_status: string }>("select account_status from profiles where id=? for update", [parentUserId]);
    if (!owner) throw new LearnerCreationError("PARENT_PROFILE_NOT_FOUND");
    if (owner.account_status === "deleted") throw new LearnerCreationError("ACCOUNT_DELETED");
    if (owner.account_status !== "active") throw new LearnerCreationError("ACCOUNT_NOT_ACTIVE");
    const current = await tx.get<Row>(`select ${ROW_COLUMNS} from learners where id=? and owner_parent_id=? for update`, [learnerId, parentUserId]);
    if (!current) throw new LearnerCreationError("LEARNER_NOT_FOUND");
    const existing = await tx.get<{ request_hash: string; status: string; response_json: unknown }>(
      `select request_hash,status,response_json from learner_profile_update_requests
       where parent_user_id=? and learner_id=? and idempotency_key=?`, [parentUserId, learnerId, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== hash) throw new LearnerCreationError("IDEMPOTENCY_KEY_REUSED");
      if (existing.status !== "completed" || !existing.response_json) throw new LearnerCreationError("LEARNER_UPDATE_IN_PROGRESS");
      return typeof existing.response_json === "string" ? JSON.parse(existing.response_json) : existing.response_json;
    }
    await tx.run(`insert into learner_profile_update_requests
      (parent_user_id,learner_id,idempotency_key,request_hash,expected_version,status) values(?,?,?,?,?,'processing')`,
      [parentUserId, learnerId, input.idempotencyKey, hash, input.expectedVersion]);
    if (Number(current.version) !== input.expectedVersion) throw new LearnerCreationError("LEARNER_VERSION_CONFLICT");
    if (hasAvatar && input.avatarId !== null) {
      const avatar = await tx.get<{ active: boolean }>("select active from approved_avatars where id=?", [input.avatarId!]);
      if (!avatar?.active) throw new LearnerCreationError("AVATAR_NOT_AVAILABLE");
    }
    const nextName = name?.displayName ?? current.display_name;
    const nextNormalized = name?.normalizedDisplayName ?? current.normalized_display_name;
    const nextDob = dob ?? dateOnly(current.date_of_birth);
    const nextAvatar = hasAvatar ? input.avatarId ?? null : current.avatar_id;
    const changedFields: string[] = [];
    if (nextName !== current.display_name) changedFields.push("displayName");
    if (nextDob !== dateOnly(current.date_of_birth)) changedFields.push("dateOfBirth");
    if (nextAvatar !== current.avatar_id) changedFields.push("avatarId");
    let resultRow = current;
    if (changedFields.length) {
      try {
        resultRow = (await tx.get<Row>(`update learners set display_name=?,normalized_display_name=?,date_of_birth=?,avatar_id=?,
          version=version+1,updated_at=now() where id=? and owner_parent_id=? and version=? returning ${ROW_COLUMNS}`,
          [nextName, nextNormalized, nextDob, nextAvatar, learnerId, parentUserId, input.expectedVersion]))!;
      } catch (error) {
        if (error instanceof Error && /unique|duplicate/i.test(error.message)) throw new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS");
        throw error;
      }
      if (!resultRow) throw new LearnerCreationError("LEARNER_VERSION_CONFLICT");
      await tx.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_profile_changed',?)",
        [randomUUID(), parentUserId, JSON.stringify({ learnerId, changedFields, previousVersion: Number(current.version), newVersion: Number(resultRow.version) })]);
    }
    const result = { learner: view(resultRow, ageAsOfDate), changedFields, noOp: changedFields.length === 0 };
    await tx.run(`update learner_profile_update_requests set result_version=?,status='completed',response_json=?,completed_at=now()
      where parent_user_id=? and learner_id=? and idempotency_key=?`,
      [Number(resultRow.version), JSON.stringify(result), parentUserId, learnerId, input.idempotencyKey]);
    return result;
  });
}
