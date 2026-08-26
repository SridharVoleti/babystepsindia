import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import {
  AppRegistryError,
  assertOnlyMutableFields,
  computeRequestHash,
  validateAppKey,
  validateDisplayName,
  validateShortDescription,
} from "@/lib/app-registry/validation";
import {
  stubReadinessAdapter,
  type EnvironmentReadinessAdapter,
} from "@/lib/app-registry/readiness-adapter";
import type { AppRegistryRow, AppRegistryStatus, SafeAppRegistryView } from "@/lib/db/types";

function safeView(row: AppRegistryRow) {
  return {
    id: row.id,
    appKey: row.app_key,
    displayName: row.display_name,
    shortDescription: row.short_description,
    iconAssetKey: row.icon_asset_key,
    category: row.category,
    owningTeam: row.owning_team,
    registryStatus: row.registry_status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    softDeletedAt: row.soft_deleted_at,
    softDeleteReasonCode: row.soft_delete_reason_code,
    // internal_notes is deliberately never included (business rule 31 / AC24).
  };
}

async function writeAudit(
  db: DbClient,
  appId: string,
  appKey: string,
  operation: string,
  adminUserId: string,
  reasonCode: string | null,
  versionFrom: number | null,
  versionTo: number | null,
) {
  await db.run(
    `insert into app_registry_audit_log
     (id, app_id, app_key, operation, admin_user_id, reason_code, version_from, version_to)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), appId, appKey, operation, adminUserId, reasonCode, versionFrom, versionTo],
  );
}

async function findMutationRequest(db: DbClient, adminUserId: string, idempotencyKey: string) {
  return db.get<{ request_hash: string; status: string; safe_response_json: string | null }>(
    `select request_hash, status, safe_response_json from app_registry_mutation_requests
     where admin_user_id = ? and idempotency_key = ?`,
    [adminUserId, idempotencyKey],
  );
}

// Shared replay/conflict check for every mutation (business rule 20).
// Returns the cached result on an exact replay, or null if this is a new
// request that should proceed.
async function checkIdempotency<T>(
  db: DbClient,
  adminUserId: string,
  idempotencyKey: string,
  hash: string,
): Promise<T | null> {
  const existing = await findMutationRequest(db, adminUserId, idempotencyKey);
  if (!existing) return null;
  if (existing.request_hash !== hash) {
    throw new AppRegistryError("IDEMPOTENCY_KEY_REUSED");
  }
  if (existing.status !== "completed" || !existing.safe_response_json) {
    throw new AppRegistryError("MUTATION_IN_PROGRESS");
  }
  return JSON.parse(existing.safe_response_json) as T;
}

async function beginMutationRequest(
  db: DbClient,
  adminUserId: string,
  idempotencyKey: string,
  operation: string,
  hash: string,
  appId: string | null,
) {
  await db.run(
    `insert into app_registry_mutation_requests
     (admin_user_id, idempotency_key, operation, app_id, request_hash, status)
     values (?, ?, ?, ?, ?, 'processing')`,
    [adminUserId, idempotencyKey, operation, appId, hash],
  );
}

async function completeMutationRequest(
  db: DbClient,
  adminUserId: string,
  idempotencyKey: string,
  resultAppId: string,
  resultVersion: number,
  result: unknown,
) {
  await db.run(
    `update app_registry_mutation_requests
     set result_app_id = ?, result_version = ?, status = 'completed',
         safe_response_json = ?, completed_at = ?
     where admin_user_id = ? and idempotency_key = ?`,
    [resultAppId, resultVersion, JSON.stringify(result), new Date().toISOString(), adminUserId, idempotencyKey],
  );
}

async function getRow(db: DbClient, appId: string): Promise<AppRegistryRow | undefined> {
  return db.get<AppRegistryRow>("select * from app_registry where id = ?", [appId]);
}

export type CreateAppInput = {
  appKey: string;
  displayName: string;
  shortDescription?: string | null;
  iconAssetKey?: string | null;
  category?: string | null;
  owningTeam?: string | null;
  internalNotes?: string | null;
  idempotencyKey: string;
};

// AC2/AC3/AC4/AC27: generated UUID, version 1, draft, globally unique key.
export async function createApp(adminUserId: string, input: CreateAppInput): Promise<SafeAppRegistryView> {
  const appKey = validateAppKey(input.appKey);
  const displayName = validateDisplayName(input.displayName);
  const shortDescription = input.shortDescription
    ? validateShortDescription(input.shortDescription)
    : null;
  const iconAssetKey = input.iconAssetKey ?? null;
  const category = input.category ?? null;
  const owningTeam = input.owningTeam ?? null;
  const internalNotes = input.internalNotes ?? null;

  const hash = computeRequestHash({
    appKey,
    displayName,
    shortDescription,
    iconAssetKey,
    category,
    owningTeam,
    internalNotes,
  });

  const db = resolveDbClient();

  const cached = await checkIdempotency<SafeAppRegistryView>(db, adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  if (iconAssetKey) {
    await assertIconApproved(db, iconAssetKey);
  }

  return db.transaction(async (tx) => {
    await beginMutationRequest(tx, adminUserId, input.idempotencyKey, "create", hash, null);

    // Precheck + a DB-level unique constraint as the concurrency-safe
    // backstop (AT-AR-001-04) — the precheck alone has a race window
    // under real concurrent writers; the constraint doesn't.
    const keyTaken = await tx.get("select 1 from app_registry where app_key = ?", [appKey]);
    if (keyTaken) {
      throw new AppRegistryError("APP_KEY_ALREADY_EXISTS");
    }

    const id = randomUUID();
    try {
      await tx.run(
        `insert into app_registry
         (id, app_key, display_name, short_description, icon_asset_key, category, owning_team, internal_notes)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, appKey, displayName, shortDescription, iconAssetKey, category, owningTeam, internalNotes],
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: app_registry.app_key")) {
        throw new AppRegistryError("APP_KEY_ALREADY_EXISTS");
      }
      throw error;
    }

    await writeAudit(tx, id, appKey, "create", adminUserId, null, null, 1);

    const result = safeView((await getRow(tx, id))!);
    await completeMutationRequest(tx, adminUserId, input.idempotencyKey, id, 1, result);
    return result;
  });
}

export type EditAppInput = {
  displayName?: string;
  shortDescription?: string | null;
  iconAssetKey?: string | null;
  category?: string | null;
  owningTeam?: string | null;
  internalNotes?: string | null;
  expectedVersion: number;
  idempotencyKey: string;
};

// AC5/AC6/AC7: mutable-only, exact no-op doesn't increment version or
// write an event, stale expectedVersion is rejected.
export async function editApp(
  adminUserId: string,
  appId: string,
  input: EditAppInput,
): Promise<SafeAppRegistryView> {
  assertOnlyMutableFields(input);

  const hasDisplayName = Object.prototype.hasOwnProperty.call(input, "displayName");
  const hasShortDescription = Object.prototype.hasOwnProperty.call(input, "shortDescription");
  const hasIconAssetKey = Object.prototype.hasOwnProperty.call(input, "iconAssetKey");
  const hasCategory = Object.prototype.hasOwnProperty.call(input, "category");
  const hasOwningTeam = Object.prototype.hasOwnProperty.call(input, "owningTeam");
  const hasInternalNotes = Object.prototype.hasOwnProperty.call(input, "internalNotes");

  const cleanedDisplayName = hasDisplayName ? validateDisplayName(input.displayName!) : null;
  const cleanedShortDescription =
    hasShortDescription && input.shortDescription ? validateShortDescription(input.shortDescription) : null;

  const canonical: Record<string, unknown> = { expectedVersion: input.expectedVersion };
  if (hasDisplayName) canonical.displayName = cleanedDisplayName;
  if (hasShortDescription) canonical.shortDescription = input.shortDescription ?? null;
  if (hasIconAssetKey) canonical.iconAssetKey = input.iconAssetKey ?? null;
  if (hasCategory) canonical.category = input.category ?? null;
  if (hasOwningTeam) canonical.owningTeam = input.owningTeam ?? null;
  if (hasInternalNotes) canonical.internalNotes = input.internalNotes ?? null;
  const hash = computeRequestHash(canonical);

  const db = resolveDbClient();

  const cached = await checkIdempotency<SafeAppRegistryView>(db, adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  if (hasIconAssetKey && input.iconAssetKey) {
    await assertIconApproved(db, input.iconAssetKey);
  }

  return db.transaction(async (tx) => {
    await beginMutationRequest(tx, adminUserId, input.idempotencyKey, "edit", hash, appId);

    const current = await getRow(tx, appId);
    if (!current) throw new AppRegistryError("APP_NOT_FOUND");
    if (current.version !== input.expectedVersion) {
      throw new AppRegistryError("APP_VERSION_CONFLICT");
    }

    const nextDisplayName = hasDisplayName ? cleanedDisplayName! : current.display_name;
    const nextShortDescription = hasShortDescription
      ? cleanedShortDescription
      : current.short_description;
    const nextIconAssetKey = hasIconAssetKey ? input.iconAssetKey ?? null : current.icon_asset_key;
    const nextCategory = hasCategory ? input.category ?? null : current.category;
    const nextOwningTeam = hasOwningTeam ? input.owningTeam ?? null : current.owning_team;
    const nextInternalNotes = hasInternalNotes ? input.internalNotes ?? null : current.internal_notes;

    const changed =
      nextDisplayName !== current.display_name ||
      nextShortDescription !== current.short_description ||
      nextIconAssetKey !== current.icon_asset_key ||
      nextCategory !== current.category ||
      nextOwningTeam !== current.owning_team ||
      nextInternalNotes !== current.internal_notes;

    let resultRow = current;
    if (changed) {
      await tx.run(
        `update app_registry set
           display_name = ?, short_description = ?, icon_asset_key = ?,
           category = ?, owning_team = ?, internal_notes = ?,
           version = version + 1, updated_at = ?
         where id = ? and version = ?`,
        [
          nextDisplayName,
          nextShortDescription,
          nextIconAssetKey,
          nextCategory,
          nextOwningTeam,
          nextInternalNotes,
          new Date().toISOString(),
          appId,
          input.expectedVersion,
        ],
      );
      resultRow = (await getRow(tx, appId))!;
      await writeAudit(tx, appId, current.app_key, "edit", adminUserId, null, current.version, resultRow.version);
    }

    const result = safeView(resultRow);
    await completeMutationRequest(tx, adminUserId, input.idempotencyKey, appId, resultRow.version, result);
    return result;
  });
}

async function assertIconApproved(db: DbClient, iconAssetKey: string) {
  const icon = await db.get<{ active: number }>(
    "select active from approved_app_icons where id = ?",
    [iconAssetKey],
  );
  if (!icon?.active) {
    throw new AppRegistryError("APP_ICON_NOT_AVAILABLE");
  }
}

async function assertReadyForActivation(db: DbClient, row: AppRegistryRow) {
  if (!row.short_description || !row.icon_asset_key || !row.category || !row.owning_team) {
    throw new AppRegistryError("APP_NOT_READY_FOR_ACTIVATION");
  }
  await assertIconApproved(db, row.icon_asset_key);
}

export type ActivateAppInput = { expectedVersion: number; idempotencyKey: string };

// AC9/AC10/AC11: complete metadata + AR-002 readiness required; draft ->
// active, version increments, event emitted. Already-active is a no-op
// (Alt flow: "transition no-op when semantically idempotent").
export async function activateApp(
  adminUserId: string,
  appId: string,
  input: ActivateAppInput,
  readinessAdapter: EnvironmentReadinessAdapter = stubReadinessAdapter,
): Promise<SafeAppRegistryView> {
  const hash = computeRequestHash({ expectedVersion: input.expectedVersion });
  const db = resolveDbClient();

  const cached = await checkIdempotency<SafeAppRegistryView>(db, adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  const current = await getRow(db, appId);
  if (!current) throw new AppRegistryError("APP_NOT_FOUND");

  if (current.registry_status === "active") {
    return safeView(current);
  }
  if (current.registry_status === "soft_deleted") {
    throw new AppRegistryError("APP_NOT_ACTIVE");
  }
  if (current.version !== input.expectedVersion) {
    throw new AppRegistryError("APP_VERSION_CONFLICT");
  }

  await assertReadyForActivation(db, current);

  const readiness = await readinessAdapter.checkReady(appId);
  if (!readiness.ready) {
    throw new AppRegistryError("APP_NOT_READY_FOR_ACTIVATION");
  }

  return db.transaction(async (tx) => {
    await beginMutationRequest(tx, adminUserId, input.idempotencyKey, "activate", hash, appId);

    const fresh = (await getRow(tx, appId))!;
    if (fresh.registry_status !== "draft" || fresh.version !== input.expectedVersion) {
      throw new AppRegistryError("APP_VERSION_CONFLICT");
    }

    await tx.run(
      `update app_registry set registry_status = 'active', activated_at = ?,
       version = version + 1, updated_at = ? where id = ? and version = ?`,
      [new Date().toISOString(), new Date().toISOString(), appId, input.expectedVersion],
    );

    const resultRow = (await getRow(tx, appId))!;
    await writeAudit(tx, appId, fresh.app_key, "activate", adminUserId, null, fresh.version, resultRow.version);

    const result = safeView(resultRow);
    await completeMutationRequest(tx, adminUserId, input.idempotencyKey, appId, resultRow.version, result);
    return result;
  });
}

export type SoftDeleteAppInput = {
  expectedVersion: number;
  idempotencyKey: string;
  reasonCode: string;
  reasonNote?: string | null;
  confirmationAppKey: string;
};

// AC15-AC18: reauth/permission/confirmation are the caller's
// responsibility (route layer, matching IA-003) — this function assumes
// they already passed and focuses on the state transition itself.
export async function softDeleteApp(
  adminUserId: string,
  appId: string,
  input: SoftDeleteAppInput,
): Promise<SafeAppRegistryView> {
  const hash = computeRequestHash({
    expectedVersion: input.expectedVersion,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote ?? null,
    confirmationAppKey: input.confirmationAppKey,
  });
  const db = resolveDbClient();

  const cached = await checkIdempotency<SafeAppRegistryView>(db, adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  return db.transaction(async (tx) => {
    await beginMutationRequest(tx, adminUserId, input.idempotencyKey, "soft_delete", hash, appId);

    const current = await getRow(tx, appId);
    if (!current) throw new AppRegistryError("APP_NOT_FOUND");
    if (current.app_key !== input.confirmationAppKey) {
      throw new AppRegistryError("CONFIRMATION_MISMATCH");
    }

    if (current.registry_status === "soft_deleted") {
      const result = safeView(current);
      await completeMutationRequest(tx, adminUserId, input.idempotencyKey, appId, current.version, result);
      return result;
    }
    if (current.version !== input.expectedVersion) {
      throw new AppRegistryError("APP_VERSION_CONFLICT");
    }

    await tx.run(
      `update app_registry set registry_status = 'soft_deleted', soft_deleted_at = ?,
       soft_delete_reason_code = ?, version = version + 1, updated_at = ?
       where id = ? and version = ?`,
      [new Date().toISOString(), input.reasonCode, new Date().toISOString(), appId, input.expectedVersion],
    );

    const resultRow = (await getRow(tx, appId))!;
    await writeAudit(
      tx,
      appId,
      current.app_key,
      "soft_delete",
      adminUserId,
      input.reasonCode,
      current.version,
      resultRow.version,
    );

    const result = safeView(resultRow);
    await completeMutationRequest(tx, adminUserId, input.idempotencyKey, appId, resultRow.version, result);
    return result;
  });
}

export type RestoreAppInput = { expectedVersion: number; idempotencyKey: string; reasonCode: string };

// AC21/AC22: soft_deleted -> draft only, same id/key, must reactivate
// separately. Restoring a non-deleted app is a no-op (Alt flow: "Restore
// always returns draft; direct restore-to-active is rejected" — there's
// nothing to transition if it isn't currently soft_deleted).
export async function restoreApp(
  adminUserId: string,
  appId: string,
  input: RestoreAppInput,
): Promise<SafeAppRegistryView> {
  const hash = computeRequestHash({ expectedVersion: input.expectedVersion, reasonCode: input.reasonCode });
  const db = resolveDbClient();

  const cached = await checkIdempotency<SafeAppRegistryView>(db, adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  return db.transaction(async (tx) => {
    await beginMutationRequest(tx, adminUserId, input.idempotencyKey, "restore", hash, appId);

    const current = await getRow(tx, appId);
    if (!current) throw new AppRegistryError("APP_NOT_FOUND");

    if (current.registry_status !== "soft_deleted") {
      const result = safeView(current);
      await completeMutationRequest(tx, adminUserId, input.idempotencyKey, appId, current.version, result);
      return result;
    }
    if (current.version !== input.expectedVersion) {
      throw new AppRegistryError("APP_VERSION_CONFLICT");
    }

    await tx.run(
      `update app_registry set registry_status = 'draft', soft_deleted_at = null,
       soft_delete_reason_code = null, version = version + 1, updated_at = ?
       where id = ? and version = ?`,
      [new Date().toISOString(), appId, input.expectedVersion],
    );

    const resultRow = (await getRow(tx, appId))!;
    await writeAudit(
      tx,
      appId,
      current.app_key,
      "restore",
      adminUserId,
      input.reasonCode,
      current.version,
      resultRow.version,
    );

    const result = safeView(resultRow);
    await completeMutationRequest(tx, adminUserId, input.idempotencyKey, appId, resultRow.version, result);
    return result;
  });
}

// The guard downstream systems (product mapping, entitlements, schedule,
// launch, session, progress, analytics) would call before writing —
// AC9/AC16/AC19, AT-AR-001-10/15/19. Unknown IDs fail closed and never
// implicitly create an app (AC14).
export async function assertAppOperational(appId: string): Promise<AppRegistryRow> {
  const row = await getRow(resolveDbClient(), appId);
  if (!row) throw new AppRegistryError("APP_NOT_FOUND");
  if (row.registry_status !== "active") throw new AppRegistryError("APP_NOT_ACTIVE");
  return row;
}

export async function getApp(appId: string): Promise<SafeAppRegistryView | null> {
  const row = await getRow(resolveDbClient(), appId);
  return row ? safeView(row) : null;
}

export async function getAppByKey(
  appKey: string,
  options: { activeOnly?: boolean } = {},
): Promise<SafeAppRegistryView | null> {
  const row = await resolveDbClient().get<AppRegistryRow>(
    "select * from app_registry where app_key = ?",
    [appKey],
  );
  if (!row) return null;
  if (options.activeOnly && row.registry_status !== "active") return null;
  return safeView(row);
}

export async function listApprovedIcons(): Promise<Array<{ id: string; label: string }>> {
  return resolveDbClient().all<{ id: string; label: string }>(
    "select id, label from approved_app_icons where active = true order by label, id",
  );
}

export async function listApps(options: {
  status?: AppRegistryStatus;
  includeSoftDeleted?: boolean;
  search?: string;
} = {}): Promise<SafeAppRegistryView[]> {
  const db = resolveDbClient();
  let query = "select * from app_registry where 1 = 1";
  const params: Array<string> = [];

  if (options.status) {
    query += " and registry_status = ?";
    params.push(options.status);
  } else if (!options.includeSoftDeleted) {
    query += " and registry_status != 'soft_deleted'";
  }

  if (options.search) {
    query += " and (app_key like ? or display_name like ?)";
    const like = `%${options.search}%`;
    params.push(like, like);
  }

  query += " order by created_at, id";

  const rows = await db.all<AppRegistryRow>(query, params);
  return rows.map(safeView);
}
