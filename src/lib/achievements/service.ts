import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

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

function contractFor(appId: string, releaseId: string) {
  return getDb().prepare(`select * from app_release_achievement_contracts where app_id=? and release_id=?`)
    .get(appId, releaseId) as ContractRow | undefined;
}

function assertContract(context: AchievementWriteContext, input: CreateAchievementInput) {
  const contract = contractFor(context.appId, context.releaseId);
  if (!contract || contract.status !== "approved" ||
      contract.achievement_contract_version !== input.achievementContractVersion ||
      contract.app_achievement_model_version !== input.appAchievementModelVersion) {
    throw new AchievementError("ACHIEVEMENT_CONTRACT_UNSUPPORTED");
  }
  if (input.badgeAssetKey) {
    const releaseAssets = JSON.parse(contract.allowed_badge_asset_keys_json) as string[];
    const approvedGeneric = getDb().prepare("select 1 from approved_app_icons where id=? and active=1")
      .get(input.badgeAssetKey);
    if (!releaseAssets.includes(input.badgeAssetKey) && !approvedGeneric) {
      throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
    }
  }
}

function assertAcknowledgedSource(context: AchievementWriteContext, input: CreateAchievementInput) {
  if (input.sourceSessionId && input.sourceSessionId !== context.learnerSessionId) {
    throw new AchievementError("ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED");
  }
  let acknowledged = false;
  if (input.sourceProgressVersion !== null && input.sourceProgressVersion !== undefined) {
    if (!Number.isInteger(input.sourceProgressVersion) || input.sourceProgressVersion < 1) {
      throw new AchievementError("ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED");
    }
    const row = getDb().prepare(`select progress_version from learner_app_progress where learner_id=? and app_id=?`)
      .get(context.learnerId, context.appId) as { progress_version: number } | undefined;
    acknowledged = !!row && row.progress_version >= input.sourceProgressVersion;
  }
  if (input.sourceCompletionId) {
    const row = getDb().prepare(`select 1 from lesson_completions where completion_id=? and learner_id=? and app_id=?`)
      .get(input.sourceCompletionId, context.learnerId, context.appId);
    acknowledged = acknowledged || !!row;
  }
  if (!acknowledged) throw new AchievementError("ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED");
}

function assertEarnedTime(context: AchievementWriteContext, earnedAt: string, now: Date) {
  const timestamp = new Date(earnedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new AchievementError("ACHIEVEMENT_TIME_INVALID");
  }
  const firstAccess = getDb().prepare(`select min(period_start) first_access from learner_app_entitlement_periods
    where learner_id=? and app_id=?`).get(context.learnerId, context.appId) as { first_access: string | null };
  const session = getDb().prepare("select started_at from learner_sessions where id=? and learner_id=? and app_id=?")
    .get(context.learnerSessionId, context.learnerId, context.appId) as { started_at: string } | undefined;
  const lowerBound = firstAccess.first_access ?? session?.started_at;
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

function achievementRow(id: string) {
  return getDb().prepare("select * from learner_achievements where id=?").get(id) as AchievementRow | undefined;
}

function enqueueJourneyProjection(achievement: AchievementRow, action: "upsert" | "remove", now: Date) {
  getDb().prepare(`insert or ignore into achievement_journey_projection_outbox
    (id,achievement_id,learner_id,app_id,action,source_state_hash,status,created_at)
    values(?,?,?,?,?,?, 'pending',?)`).run(randomUUID(), achievement.id, achievement.learner_id, achievement.app_id,
      action, achievement.state_hash, now.toISOString());
}

function audit(learnerId: string, eventType: string, metadata: Record<string, unknown>) {
  const learner = getDb().prepare("select owner_parent_id from learners where id=?").get(learnerId) as
    { owner_parent_id: string } | undefined;
  if (!learner) return;
  getDb().prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)")
    .run(randomUUID(), learner.owner_parent_id, eventType, JSON.stringify(metadata));
}

export function createAchievement(context: AchievementWriteContext, rawInput: CreateAchievementInput, now: Date) {
  const input = normalizedCreateInput(rawInput);
  assertContract(context, input);
  assertAcknowledgedSource(context, input);
  const earnedAt = assertEarnedTime(context, input.earnedAt, now);
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
  const db = getDb();
  return db.transaction(() => {
    const receipt = db.prepare(`select request_hash,response_json from achievement_mutation_receipts
      where app_id=? and action='create' and idempotency_key=?`).get(context.appId, input.idempotencyKey) as
      { request_hash: string; response_json: string } | undefined;
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new AchievementError("IDEMPOTENCY_KEY_REUSED");
      return JSON.parse(receipt.response_json) as { created: boolean; achievement: AchievementView };
    }
    const existing = db.prepare(`select * from learner_achievements
      where learner_id=? and app_id=? and achievement_instance_key=?`)
      .get(context.learnerId, context.appId, input.achievementInstanceKey) as AchievementRow | undefined;
    if (existing) {
      if (existing.state_hash !== stateHash) throw new AchievementError("ACHIEVEMENT_INSTANCE_CONFLICT");
      const result = { created: false, achievement: toView(existing) };
      db.prepare(`insert into achievement_mutation_receipts
        (id,app_id,achievement_id,action,idempotency_key,request_hash,response_json,created_at)
        values(?,?,?,'create',?,?,?,?)`).run(randomUUID(), context.appId, existing.id, input.idempotencyKey,
          requestHash, JSON.stringify(result), now.toISOString());
      audit(existing.learner_id, "achievement_replayed", { achievementId: existing.id, appId: context.appId,
        category: existing.category });
      return result;
    }
    const app = db.prepare("select app_key,display_name,icon_asset_key from app_registry where id=?")
      .get(context.appId) as { app_key: string; display_name: string; icon_asset_key: string | null } | undefined;
    if (!app) throw new AchievementError("ACHIEVEMENT_RESOURCE_NOT_FOUND");
    const id = randomUUID();
    const acknowledgedAt = now.toISOString();
    db.prepare(`insert into learner_achievements
      (id,learner_id,app_id,environment,app_achievement_key,achievement_instance_key,
       achievement_contract_version,app_achievement_model_version,title,short_description,badge_asset_key,category,
       earned_at,source_progress_version,source_completion_id,source_session_id,source_release_id,
       app_key_snapshot,app_name_snapshot,app_icon_asset_key_snapshot,record_version,state_hash,acknowledged_at,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(id, context.learnerId, context.appId,
        context.environment, input.appAchievementKey, input.achievementInstanceKey,
        input.achievementContractVersion, input.appAchievementModelVersion, input.title,
        input.shortDescription ?? null, input.badgeAssetKey ?? null, input.category, earnedAt,
        input.sourceProgressVersion ?? null, input.sourceCompletionId ?? null, input.sourceSessionId ?? null,
        context.releaseId, app.app_key, app.display_name, app.icon_asset_key, stateHash, acknowledgedAt, acknowledgedAt);
    const created = achievementRow(id)!;
    const result = { created: true, achievement: toView(created) };
    db.prepare(`insert into achievement_mutation_receipts
      (id,app_id,achievement_id,action,idempotency_key,request_hash,response_json,created_at)
      values(?,?,?,'create',?,?,?,?)`).run(randomUUID(), context.appId, id, input.idempotencyKey,
        requestHash, JSON.stringify(result), acknowledgedAt);
    enqueueJourneyProjection(created, "upsert", now);
    audit(context.learnerId, "achievement_created", { achievementId: id, appId: context.appId,
      category: input.category, earnedAt });
    return result;
  })();
}

export function revokeAchievement(input: {
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
  const db = getDb();
  return db.transaction(() => {
    const receipt = db.prepare(`select request_hash,response_json from achievement_mutation_receipts
      where app_id=? and action='revoke' and idempotency_key=?`).get(input.appId, input.request.idempotencyKey) as
      { request_hash: string; response_json: string } | undefined;
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new AchievementError("IDEMPOTENCY_KEY_REUSED");
      return JSON.parse(receipt.response_json) as { achievementId: string; recordVersion: number; revokedAt: string };
    }
    const row = achievementRow(input.achievementId);
    if (!row || row.app_id !== input.appId || row.environment !== input.environment) {
      throw new AchievementError("ACHIEVEMENT_RESOURCE_NOT_FOUND");
    }
    if (row.revoked_at) throw new AchievementError("ACHIEVEMENT_ALREADY_REVOKED");
    if (row.record_version !== input.request.expectedRecordVersion) {
      throw new AchievementError("ACHIEVEMENT_VERSION_CONFLICT");
    }
    const revokedAt = input.now.toISOString();
    db.prepare(`update learner_achievements set revoked_at=?,revocation_reason_code=?,revoked_by_principal_id=?,
      record_version=record_version+1 where id=? and record_version=? and revoked_at is null`)
      .run(revokedAt, input.request.reasonCode, input.principalId, row.id, input.request.expectedRecordVersion);
    const revoked = achievementRow(row.id)!;
    const result = { achievementId: row.id, recordVersion: revoked.record_version, revokedAt };
    db.prepare(`insert into achievement_mutation_receipts
      (id,app_id,achievement_id,action,idempotency_key,request_hash,response_json,created_at)
      values(?,?,?,'revoke',?,?,?,?)`).run(randomUUID(), input.appId, row.id, input.request.idempotencyKey,
        requestHash, JSON.stringify(result), revokedAt);
    enqueueJourneyProjection(revoked, "remove", input.now);
    audit(row.learner_id, "achievement_revoked", { achievementId: row.id, appId: row.app_id,
      reasonCode: input.request.reasonCode });
    return result;
  })();
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

export function listAchievements(input: {
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
  const rows = getDb().prepare(`select * from learner_achievements where ${where.join(" and ")}
    order by earned_at desc,id desc limit ?`).all(...params, limit + 1) as AchievementRow[];
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

export function listRecentAchievements(learnerId: string, limit = 3) {
  return listAchievements({ learnerId, limit }).achievements;
}

export function registerReleaseAchievementContract(input: {
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
  getDb().prepare(`insert into app_release_achievement_contracts
    (app_id,release_id,achievement_contract_version,app_achievement_model_version,
     allowed_badge_asset_keys_json,status,created_at,updated_at)
    values(?,?,?,?,?,'pending',?,?)
    on conflict(app_id,release_id) do update set achievement_contract_version=excluded.achievement_contract_version,
      app_achievement_model_version=excluded.app_achievement_model_version,
      allowed_badge_asset_keys_json=excluded.allowed_badge_asset_keys_json,status='pending',updated_at=excluded.updated_at`)
    .run(input.appId, input.releaseId, input.achievementContractVersion, input.appAchievementModelVersion,
      JSON.stringify([...new Set(input.allowedBadgeAssetKeys)]), input.now.toISOString(), input.now.toISOString());
}

export function validateReleaseAchievementContract(appId: string, releaseId: string, now: Date) {
  const contract = contractFor(appId, releaseId);
  if (!contract) return { declared: false, passed: true };
  const assets = JSON.parse(contract.allowed_badge_asset_keys_json) as string[];
  const missing = assets.filter((asset) => !getDb().prepare("select 1 from approved_app_icons where id=? and active=1").get(asset));
  const passed = missing.length === 0;
  getDb().prepare(`update app_release_achievement_contracts set status=?,validation_report_json=?,validated_at=?,updated_at=?
    where app_id=? and release_id=?`).run(passed ? "approved" : "blocked",
      JSON.stringify({ passed, missingAssetKeys: missing }), now.toISOString(), now.toISOString(), appId, releaseId);
  return { declared: true, passed, missingAssetKeys: missing };
}

export function getReleaseAchievementContract(appId: string, releaseId: string) {
  const row = contractFor(appId, releaseId);
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
