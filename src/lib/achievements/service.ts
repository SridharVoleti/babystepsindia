import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { projectAchievementOutbox } from "@/lib/journey/service";

export const ACHIEVEMENT_CATEGORIES = [
  "milestone", "mastery", "level", "efficiency", "challenge", "consistency", "other",
] as const;
export type AchievementCategory = typeof ACHIEVEMENT_CATEGORIES[number];

export type AchievementWriteContext = {
  grantId: string;
  learnerSessionId: string;
  learnerId: string;
  appId: string;
  principalId: string;
  environment: string;
  deploymentId: string;
  releaseId: string;
};

export type CreateAchievementInput = {
  achievementContractVersion: string;
  appAchievementKey: string;
  achievementInstanceKey: string;
  title: string;
  shortDescription?: string | null;
  badgeAssetKey?: string | null;
  category: AchievementCategory;
  earnedAt: string;
  appAchievementModelVersion: string;
  sourceProgressVersion?: number | null;
  sourceCompletionId?: string | null;
  sourceSessionId?: string | null;
  idempotencyKey: string;
};

export type RevokeAchievementInput = {
  expectedRecordVersion: number;
  reasonCode: "app_error" | "duplicate_emission" | "invalid_source";
  idempotencyKey: string;
};

export type AchievementView = {
  achievementId: string;
  appId: string;
  appKey: string;
  appName: string;
  appIconAssetKey: string | null;
  appAchievementKey: string;
  achievementInstanceKey: string;
  title: string;
  shortDescription: string | null;
  badgeAssetKey: string | null;
  category: AchievementCategory;
  earnedAt: string;
  appAchievementModelVersion: string;
  recordVersion: number;
  acknowledgedAt: string;
};

type AchievementRow = {
  id: string;
  learner_id: string;
  app_id: string;
  environment: string;
  app_achievement_key: string;
  achievement_instance_key: string;
  achievement_contract_version: string;
  app_achievement_model_version: string;
  title: string;
  short_description: string | null;
  badge_asset_key: string | null;
  category: AchievementCategory;
  earned_at: string;
  source_progress_version: number | null;
  source_completion_id: string | null;
  source_session_id: string | null;
  source_release_id: string;
  app_key_snapshot: string;
  app_name_snapshot: string;
  app_icon_asset_key_snapshot: string | null;
  record_version: number;
  state_hash: string;
  acknowledged_at: string;
  revoked_at: string | null;
  revocation_reason_code: string | null;
};

type ContractRow = {
  app_id: string;
  release_id: string;
  achievement_contract_version: string;
  app_achievement_model_version: string;
  allowed_badge_asset_keys_json: string;
  status: "pending" | "approved" | "blocked";
};

export class AchievementError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AchievementError";
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 4096;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeText(value: string, maxLength: number, required: boolean) {
  if (typeof value !== "string") throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if ((required && !normalized) || normalized.length > maxLength) {
    throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
  }
  if (/[<>]/.test(normalized) || /(?:https?:\/\/|www\.|javascript:|bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token)/i.test(normalized)) {
    throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeText(value, maxLength, false) || null;
}

function normalizedCreateInput(input: CreateAchievementInput): CreateAchievementInput {
  if (!KEY_PATTERN.test(input.appAchievementKey) || !KEY_PATTERN.test(input.achievementInstanceKey) ||
      !VERSION_PATTERN.test(input.achievementContractVersion) || !VERSION_PATTERN.test(input.appAchievementModelVersion) ||
      !KEY_PATTERN.test(input.idempotencyKey) || !ACHIEVEMENT_CATEGORIES.includes(input.category)) {
    throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
  }
  const normalized = {
    ...input,
    title: normalizeText(input.title, 100, true),
    shortDescription: normalizeOptionalText(input.shortDescription, 240),
    badgeAssetKey: normalizeOptionalText(input.badgeAssetKey, 128),
    sourceCompletionId: normalizeOptionalText(input.sourceCompletionId, 128),
    sourceSessionId: normalizeOptionalText(input.sourceSessionId, 128),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new AchievementError("ACHIEVEMENT_PAYLOAD_TOO_LARGE");
  }
  return normalized;
}

// Never called from inside a transaction in this file — resolveDbClient()
// directly is fine.
async function contractFor(appId: string, releaseId: string) {
  return resolveDbClient().get<ContractRow>(
    `select * from app_release_achievement_contracts where app_id=? and release_id=?`, [appId, releaseId]);
}

async function assertContract(context: AchievementWriteContext, input: CreateAchievementInput) {
  const contract = await contractFor(context.appId, context.releaseId);
  if (!contract || contract.status !== "approved" ||
      contract.achievement_contract_version !== input.achievementContractVersion ||
      contract.app_achievement_model_version !== input.appAchievementModelVersion) {
    throw new AchievementError("ACHIEVEMENT_CONTRACT_UNSUPPORTED");
  }
  if (input.badgeAssetKey) {
    const releaseAssets = JSON.parse(contract.allowed_badge_asset_keys_json) as string[];
    const approvedGeneric = await resolveDbClient().get("select 1 from approved_app_icons where id=? and active=1",
      [input.badgeAssetKey]);
    if (!releaseAssets.includes(input.badgeAssetKey) && !approvedGeneric) {
      throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
    }
  }
}

async function assertAcknowledgedSource(context: AchievementWriteContext, input: CreateAchievementInput) {
  if (input.sourceSessionId && input.sourceSessionId !== context.learnerSessionId) {
    throw new AchievementError("ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED");
  }
  let acknowledged = false;
  if (input.sourceProgressVersion !== null && input.sourceProgressVersion !== undefined) {
    if (!Number.isInteger(input.sourceProgressVersion) || input.sourceProgressVersion < 1) {
      throw new AchievementError("ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED");
    }
    const row = await resolveDbClient().get<{ progress_version: number }>(
      `select progress_version from learner_app_progress where learner_id=? and app_id=?`,
      [context.learnerId, context.appId]);
    acknowledged = !!row && row.progress_version >= input.sourceProgressVersion;
  }
  if (input.sourceCompletionId) {
    const row = await resolveDbClient().get(
      `select 1 from lesson_completions where completion_id=? and learner_id=? and app_id=?`,
      [input.sourceCompletionId, context.learnerId, context.appId]);
    acknowledged = acknowledged || !!row;
  }
  if (!acknowledged) throw new AchievementError("ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED");
}

async function assertEarnedTime(context: AchievementWriteContext, earnedAt: string, now: Date) {
  const timestamp = new Date(earnedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new AchievementError("ACHIEVEMENT_TIME_INVALID");
  }
  const firstAccess = await resolveDbClient().get<{ first_access: string | null }>(
    `select min(period_start) first_access from learner_app_entitlement_periods
    where learner_id=? and app_id=?`, [context.learnerId, context.appId]);
  const session = await resolveDbClient().get<{ started_at: string }>(
    "select started_at from learner_sessions where id=? and learner_id=? and app_id=?",
    [context.learnerSessionId, context.learnerId, context.appId]);
  const lowerBound = firstAccess?.first_access ?? session?.started_at;
  if (!lowerBound || timestamp.getTime() < new Date(lowerBound).getTime()) {
    throw new AchievementError("ACHIEVEMENT_TIME_INVALID");
  }
  return timestamp.toISOString();
}

function toView(row: AchievementRow): AchievementView {
  return {
    achievementId: row.id,
    appId: row.app_id,
    appKey: row.app_key_snapshot,
    appName: row.app_name_snapshot,
    appIconAssetKey: row.app_icon_asset_key_snapshot,
    appAchievementKey: row.app_achievement_key,
    achievementInstanceKey: row.achievement_instance_key,
    title: row.title,
    shortDescription: row.short_description,
    badgeAssetKey: row.badge_asset_key,
    category: row.category,
    earnedAt: row.earned_at,
    appAchievementModelVersion: row.app_achievement_model_version,
    recordVersion: row.record_version,
    acknowledgedAt: row.acknowledged_at,
  };
}

// Always called from inside createAchievement/revokeAchievement's own
// transaction — the caller must pass that transaction's DbClient so the
// read sees the transaction's own uncommitted writes.
async function achievementRow(db: DbClient, id: string) {
  return db.get<AchievementRow>("select * from learner_achievements where id=?", [id]);
}

async function enqueueJourneyProjection(db: DbClient, achievement: AchievementRow, action: "upsert" | "remove", now: Date) {
  const id = randomUUID();
  await db.run(`insert or ignore into achievement_journey_projection_outbox
    (id,achievement_id,learner_id,app_id,action,source_state_hash,status,created_at)
    values(?,?,?,?,?,?, 'pending',?)`, [id, achievement.id, achievement.learner_id, achievement.app_id,
      action, achievement.state_hash, now.toISOString()]);
  const row = await db.get<{ id: string }>(`select id from achievement_journey_projection_outbox
    where achievement_id=? and action=? and source_state_hash=?`, [achievement.id, action, achievement.state_hash]);
  return row!.id;
}

// Runs after the owning transaction has committed — resolveDbClient()
// directly is correct here.
async function tryProjectAchievement(achievementId: string, action: "upsert" | "remove", now: Date) {
  const outbox = await resolveDbClient().get<{ id: string }>(`select id from achievement_journey_projection_outbox
    where achievement_id=? and action=? order by created_at desc,id desc limit 1`, [achievementId, action]);
  if (!outbox) return;
  try { await projectAchievementOutbox(outbox.id, { markProcessed: false, now }); } catch { /* EG-001 remains authoritative */ }
}

async function audit(db: DbClient, learnerId: string, eventType: string, metadata: Record<string, unknown>) {
  const learner = await db.get<{ owner_parent_id: string }>("select owner_parent_id from learners where id=?", [learnerId]);
  if (!learner) return;
  await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
    [randomUUID(), learner.owner_parent_id, eventType, JSON.stringify(metadata)]);
}

export async function createAchievement(context: AchievementWriteContext, rawInput: CreateAchievementInput, now: Date) {
  const input = normalizedCreateInput(rawInput);
  await assertContract(context, input);
  await assertAcknowledgedSource(context, input);
  const earnedAt = await assertEarnedTime(context, input.earnedAt, now);
  const state = {
    appAchievementKey: input.appAchievementKey,
    achievementInstanceKey: input.achievementInstanceKey,
    achievementContractVersion: input.achievementContractVersion,
    appAchievementModelVersion: input.appAchievementModelVersion,
    title: input.title,
    shortDescription: input.shortDescription ?? null,
    badgeAssetKey: input.badgeAssetKey ?? null,
    category: input.category,
    earnedAt,
    sourceProgressVersion: input.sourceProgressVersion ?? null,
    sourceCompletionId: input.sourceCompletionId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    releaseId: context.releaseId,
  };
  const stateHash = hash(state);
  const requestHash = hash({ ...state, idempotencyKey: input.idempotencyKey });
  const committed = await resolveDbClient().transaction(async (db) => {
    const receipt = await db.get<{ request_hash: string; response_json: string }>(
      `select request_hash,response_json from achievement_mutation_receipts
      where app_id=? and action='create' and idempotency_key=?`, [context.appId, input.idempotencyKey]);
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new AchievementError("IDEMPOTENCY_KEY_REUSED");
      return JSON.parse(receipt.response_json) as { created: boolean; achievement: AchievementView };
    }
    const existing = await db.get<AchievementRow>(`select * from learner_achievements
      where learner_id=? and app_id=? and achievement_instance_key=?`,
      [context.learnerId, context.appId, input.achievementInstanceKey]);
    if (existing) {
      if (existing.state_hash !== stateHash) throw new AchievementError("ACHIEVEMENT_INSTANCE_CONFLICT");
      const result = { created: false, achievement: toView(existing) };
      await db.run(`insert into achievement_mutation_receipts
        (id,app_id,achievement_id,action,idempotency_key,request_hash,response_json,created_at)
        values(?,?,?,'create',?,?,?,?)`, [randomUUID(), context.appId, existing.id, input.idempotencyKey,
          requestHash, JSON.stringify(result), now.toISOString()]);
      await audit(db, existing.learner_id, "achievement_replayed", { achievementId: existing.id, appId: context.appId,
        category: existing.category });
      return result;
    }
    const app = await db.get<{ app_key: string; display_name: string; icon_asset_key: string | null }>(
      "select app_key,display_name,icon_asset_key from app_registry where id=?", [context.appId]);
    if (!app) throw new AchievementError("ACHIEVEMENT_RESOURCE_NOT_FOUND");
    const id = randomUUID();
    const acknowledgedAt = now.toISOString();
    await db.run(`insert into learner_achievements
      (id,learner_id,app_id,environment,app_achievement_key,achievement_instance_key,
       achievement_contract_version,app_achievement_model_version,title,short_description,badge_asset_key,category,
       earned_at,source_progress_version,source_completion_id,source_session_id,source_release_id,
       app_key_snapshot,app_name_snapshot,app_icon_asset_key_snapshot,record_version,state_hash,acknowledged_at,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, [id, context.learnerId, context.appId,
        context.environment, input.appAchievementKey, input.achievementInstanceKey,
        input.achievementContractVersion, input.appAchievementModelVersion, input.title,
        input.shortDescription ?? null, input.badgeAssetKey ?? null, input.category, earnedAt,
        input.sourceProgressVersion ?? null, input.sourceCompletionId ?? null, input.sourceSessionId ?? null,
        context.releaseId, app.app_key, app.display_name, app.icon_asset_key, stateHash, acknowledgedAt, acknowledgedAt]);
    const created = (await achievementRow(db, id))!;
    const result = { created: true, achievement: toView(created) };
    await db.run(`insert into achievement_mutation_receipts
      (id,app_id,achievement_id,action,idempotency_key,request_hash,response_json,created_at)
      values(?,?,?,'create',?,?,?,?)`, [randomUUID(), context.appId, id, input.idempotencyKey,
        requestHash, JSON.stringify(result), acknowledgedAt]);
    await enqueueJourneyProjection(db, created, "upsert", now);
    await audit(db, context.learnerId, "achievement_created", { achievementId: id, appId: context.appId,
      category: input.category, earnedAt });
    return result;
  });
  await tryProjectAchievement(committed.achievement.achievementId, "upsert", now);
  return committed;
}

export async function revokeAchievement(input: {
  achievementId: string;
  appId: string;
  environment: string;
  principalId: string;
  request: RevokeAchievementInput;
  now: Date;
}) {
  if (!Number.isInteger(input.request.expectedRecordVersion) || input.request.expectedRecordVersion < 1 ||
      !["app_error", "duplicate_emission", "invalid_source"].includes(input.request.reasonCode) ||
      !KEY_PATTERN.test(input.request.idempotencyKey)) throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
  const requestHash = hash(input.request);
  const committed = await resolveDbClient().transaction(async (db) => {
    const receipt = await db.get<{ request_hash: string; response_json: string }>(
      `select request_hash,response_json from achievement_mutation_receipts
      where app_id=? and action='revoke' and idempotency_key=?`, [input.appId, input.request.idempotencyKey]);
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new AchievementError("IDEMPOTENCY_KEY_REUSED");
      return JSON.parse(receipt.response_json) as { achievementId: string; recordVersion: number; revokedAt: string };
    }
    const row = await achievementRow(db, input.achievementId);
    if (!row || row.app_id !== input.appId || row.environment !== input.environment) {
      throw new AchievementError("ACHIEVEMENT_RESOURCE_NOT_FOUND");
    }
    if (row.revoked_at) throw new AchievementError("ACHIEVEMENT_ALREADY_REVOKED");
    if (row.record_version !== input.request.expectedRecordVersion) {
      throw new AchievementError("ACHIEVEMENT_VERSION_CONFLICT");
    }
    const revokedAt = input.now.toISOString();
    await db.run(`update learner_achievements set revoked_at=?,revocation_reason_code=?,revoked_by_principal_id=?,
      record_version=record_version+1 where id=? and record_version=? and revoked_at is null`,
      [revokedAt, input.request.reasonCode, input.principalId, row.id, input.request.expectedRecordVersion]);
    const revoked = (await achievementRow(db, row.id))!;
    const result = { achievementId: row.id, recordVersion: revoked.record_version, revokedAt };
    await db.run(`insert into achievement_mutation_receipts
      (id,app_id,achievement_id,action,idempotency_key,request_hash,response_json,created_at)
      values(?,?,?,'revoke',?,?,?,?)`, [randomUUID(), input.appId, row.id, input.request.idempotencyKey,
        requestHash, JSON.stringify(result), revokedAt]);
    await enqueueJourneyProjection(db, revoked, "remove", input.now);
    await audit(db, row.learner_id, "achievement_revoked", { achievementId: row.id, appId: row.app_id,
      reasonCode: input.request.reasonCode });
    return result;
  });
  await tryProjectAchievement(committed.achievementId, "remove", input.now);
  return committed;
}

type AchievementCursor = { earnedAt: string; id: string };

function decodeCursor(cursor: string | null | undefined): AchievementCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as AchievementCursor;
    if (!value.id || !Number.isFinite(new Date(value.earnedAt).getTime())) throw new Error("invalid");
    return value;
  } catch {
    throw new AchievementError("ACHIEVEMENT_CURSOR_INVALID");
  }
}

export async function listAchievements(input: {
  learnerId: string;
  cursor?: string | null;
  limit?: number;
  appId?: string | null;
  category?: string | null;
}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (input.category && !ACHIEVEMENT_CATEGORIES.includes(input.category as AchievementCategory))) {
    throw new AchievementError("ACHIEVEMENT_QUERY_INVALID");
  }
  const cursor = decodeCursor(input.cursor);
  const where = ["learner_id=?", "revoked_at is null"];
  const params: unknown[] = [input.learnerId];
  if (input.appId) { where.push("app_id=?"); params.push(input.appId); }
  if (input.category) { where.push("category=?"); params.push(input.category); }
  if (cursor) {
    where.push("(earned_at<? or (earned_at=? and id<?))");
    params.push(cursor.earnedAt, cursor.earnedAt, cursor.id);
  }
  const rows = await resolveDbClient().all<AchievementRow>(`select * from learner_achievements where ${where.join(" and ")}
    order by earned_at desc,id desc limit ?`, [...params, limit + 1] as never[]);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const tail = page.at(-1);
  return {
    achievements: page.map(toView),
    nextCursor: hasMore && tail
      ? Buffer.from(JSON.stringify({ earnedAt: tail.earned_at, id: tail.id })).toString("base64url")
      : null,
  };
}

export async function listRecentAchievements(learnerId: string, limit = 3) {
  return (await listAchievements({ learnerId, limit })).achievements;
}

export async function registerReleaseAchievementContract(input: {
  appId: string;
  releaseId: string;
  achievementContractVersion: string;
  appAchievementModelVersion: string;
  allowedBadgeAssetKeys: string[];
  now: Date;
}) {
  if (!VERSION_PATTERN.test(input.achievementContractVersion) ||
      !VERSION_PATTERN.test(input.appAchievementModelVersion) ||
      input.allowedBadgeAssetKeys.length > 100 || input.allowedBadgeAssetKeys.some((key) => !KEY_PATTERN.test(key))) {
    throw new AchievementError("ACHIEVEMENT_CONTRACT_INVALID");
  }
  await resolveDbClient().run(`insert into app_release_achievement_contracts
    (app_id,release_id,achievement_contract_version,app_achievement_model_version,
     allowed_badge_asset_keys_json,status,created_at,updated_at)
    values(?,?,?,?,?,'pending',?,?)
    on conflict(app_id,release_id) do update set achievement_contract_version=excluded.achievement_contract_version,
      app_achievement_model_version=excluded.app_achievement_model_version,
      allowed_badge_asset_keys_json=excluded.allowed_badge_asset_keys_json,status='pending',updated_at=excluded.updated_at`,
    [input.appId, input.releaseId, input.achievementContractVersion, input.appAchievementModelVersion,
      JSON.stringify([...new Set(input.allowedBadgeAssetKeys)]), input.now.toISOString(), input.now.toISOString()]);
}

export async function validateReleaseAchievementContract(appId: string, releaseId: string, now: Date) {
  const contract = await contractFor(appId, releaseId);
  if (!contract) return { declared: false, passed: true };
  const assets = JSON.parse(contract.allowed_badge_asset_keys_json) as string[];
  const missing: string[] = [];
  for (const asset of assets) {
    const found = await resolveDbClient().get("select 1 from approved_app_icons where id=? and active=1", [asset]);
    if (!found) missing.push(asset);
  }
  const passed = missing.length === 0;
  await resolveDbClient().run(`update app_release_achievement_contracts set status=?,validation_report_json=?,validated_at=?,updated_at=?
    where app_id=? and release_id=?`, [passed ? "approved" : "blocked",
      JSON.stringify({ passed, missingAssetKeys: missing }), now.toISOString(), now.toISOString(), appId, releaseId]);
  return { declared: true, passed, missingAssetKeys: missing };
}

export async function getReleaseAchievementContract(appId: string, releaseId: string) {
  const row = await contractFor(appId, releaseId);
  if (!row) throw new AchievementError("ACHIEVEMENT_CONTRACT_NOT_FOUND");
  return {
    appId: row.app_id,
    releaseId: row.release_id,
    contractVersion: row.achievement_contract_version,
    modelVersion: row.app_achievement_model_version,
    allowedBadgeAssetKeys: JSON.parse(row.allowed_badge_asset_keys_json) as string[],
    status: row.status,
  };
}
