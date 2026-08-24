import { createHash, randomUUID } from "node:crypto";
import { validateProgressSummaryWithMotivation, ProgressMotivationValidationError }
  from "@/lib/progress-motivation/validation";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { computeCanonicalStateHash, validateProgressIntegrity } from "@/lib/progress-integrity/service";

export class ProgressSchemaRegistryError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ProgressSchemaRegistryError"; }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// PR-001: a deliberately small, deterministic transform vocabulary —
// rename/default/drop at the top level of the state object — rather than
// arbitrary migration code. Real enough to carry a genuine schema bump,
// bounded enough to run safely with no sandboxing.
export type SchemaTransform = {
  renameFields?: Record<string, string>;
  setDefaults?: Record<string, unknown>;
  dropFields?: string[];
};

function validateTransform(transform: unknown): SchemaTransform {
  if (!transform || typeof transform !== "object" || Array.isArray(transform)) {
    throw new ProgressSchemaRegistryError("SCHEMA_TRANSFORM_INVALID");
  }
  const { renameFields, setDefaults, dropFields, ...rest } = transform as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new ProgressSchemaRegistryError("SCHEMA_TRANSFORM_INVALID");
  if (renameFields !== undefined && (typeof renameFields !== "object" || Array.isArray(renameFields)))
    throw new ProgressSchemaRegistryError("SCHEMA_TRANSFORM_INVALID");
  if (setDefaults !== undefined && (typeof setDefaults !== "object" || Array.isArray(setDefaults)))
    throw new ProgressSchemaRegistryError("SCHEMA_TRANSFORM_INVALID");
  if (dropFields !== undefined && (!Array.isArray(dropFields) || dropFields.some((f) => typeof f !== "string")))
    throw new ProgressSchemaRegistryError("SCHEMA_TRANSFORM_INVALID");
  return { renameFields: renameFields as Record<string, string> | undefined,
    setDefaults: setDefaults as Record<string, unknown> | undefined, dropFields: dropFields as string[] | undefined };
}

export function applyDeclarativeTransform(state: unknown, transform: SchemaTransform): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const result: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  for (const [from, to] of Object.entries(transform.renameFields ?? {})) {
    if (from in result) { result[to] = result[from]; delete result[from]; }
  }
  for (const field of transform.dropFields ?? []) delete result[field];
  for (const [key, value] of Object.entries(transform.setDefaults ?? {})) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

export async function registerProgressSchema(input: { appId: string; releaseId: string; schemaVersion: number;
  schemaJson: string; now: Date }) {
  let parsed: unknown;
  try { parsed = JSON.parse(input.schemaJson); } catch { throw new ProgressSchemaRegistryError("PROGRESS_SCHEMA_INVALID"); }
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "object") {
    throw new ProgressSchemaRegistryError("PROGRESS_SCHEMA_INVALID");
  }
  await resolveDbClient().run(`insert into app_progress_schemas(app_id,release_id,schema_version,schema_json,schema_digest,status,created_at)
    values(?,?,?,?,?,'active',?) on conflict(app_id,release_id,schema_version) do nothing`,
    [input.appId, input.releaseId, input.schemaVersion, input.schemaJson, digest(input.schemaJson), input.now.toISOString()]);
}

export async function registerSchemaMigration(input: { appId: string; fromSchemaVersion: number; toSchemaVersion: number;
  transform: unknown; now: Date }) {
  if (Math.abs(input.toSchemaVersion - input.fromSchemaVersion) !== 1) {
    throw new ProgressSchemaRegistryError("SCHEMA_MIGRATION_STEP_INVALID");
  }
  const transform = validateTransform(input.transform);
  const db=resolveDbClient(); const serialized=JSON.stringify(transform);
  const inserted=await db.run(`insert into app_progress_schema_migrations(id,app_id,from_schema_version,to_schema_version,transform_json,registered_at)
    values(?,?,?,?,?,?) on conflict(app_id,from_schema_version,to_schema_version) do nothing`,
    [randomUUID(),input.appId,input.fromSchemaVersion,input.toSchemaVersion,serialized,input.now.toISOString()]);
  if(inserted.changes===0){
    const existing=await db.get<{transform_json:string}>(`select transform_json from app_progress_schema_migrations
      where app_id=? and from_schema_version=? and to_schema_version=?`,
    [input.appId,input.fromSchemaVersion,input.toSchemaVersion]);
    if(existing?.transform_json!==serialized)throw new ProgressSchemaRegistryError("SCHEMA_MIGRATION_IMMUTABLE");
  }
}

type MigrationStep = { toSchemaVersion: number; transform: SchemaTransform };

// Walks one adjacent version at a time toward `toVersion`; returns null the
// instant a required step is unregistered rather than partially applying.
async function walkPathWithClient(db:DbClient,appId: string, fromVersion: number, toVersion: number): Promise<MigrationStep[] | null> {
  if (fromVersion === toVersion) return [];
  const direction = toVersion > fromVersion ? 1 : -1;
  const steps: MigrationStep[] = [];
  let current = fromVersion;
  while (current !== toVersion) {
    const next = current + direction;
    const row = await db.get<{ transform_json: string }>(`select transform_json from app_progress_schema_migrations
      where app_id=? and from_schema_version=? and to_schema_version=?`, [appId, current, next]);
    if (!row) return null;
    steps.push({ toSchemaVersion: next, transform: JSON.parse(row.transform_json) });
    current = next;
  }
  return steps;
}

async function walkPath(appId:string,fromVersion:number,toVersion:number){
  return walkPathWithClient(resolveDbClient(),appId,fromVersion,toVersion);
}

export async function hasMigrationPath(appId: string, fromVersion: number, toVersion: number): Promise<boolean> {
  return (await walkPath(appId, fromVersion, toVersion)) !== null;
}

// GAP-054/092: deterministic, step-by-step, in either direction — the
// caller is responsible for persisting the result and bumping the stored
// schema_version to match.
export async function migrateProgressState(appId: string, fromVersion: number, toVersion: number, state: unknown): Promise<unknown> {
  const steps = await walkPath(appId, fromVersion, toVersion);
  if (!steps) throw new ProgressSchemaRegistryError("PROGRESS_SCHEMA_MIGRATION_PATH_MISSING");
  return steps.reduce((current, step) => applyDeclarativeTransform(current, step.transform), state);
}

async function migrateProgressStateWithClient(db:DbClient,appId:string,fromVersion:number,toVersion:number,state:unknown){
  const steps=await walkPathWithClient(db,appId,fromVersion,toVersion);
  if(!steps)throw new ProgressSchemaRegistryError("PROGRESS_SCHEMA_MIGRATION_PATH_MISSING");
  return steps.reduce((current,step)=>applyDeclarativeTransform(current,step.transform),state);
}

// PR-004 rule 33: an app counts as "mandatory-progress" for SC-003's
// usable-launch gate once it has an active registered progress schema for
// the release — the same signal migrateLearnerProgressToReleaseSchema and
// assertReleaseSchemaCompatibility already use as "something to gate."
export async function isMandatoryProgressApp(appId: string, releaseId: string): Promise<boolean> {
  const registered = await resolveDbClient().get(`select 1 as x from app_progress_schemas
    where app_id=? and release_id=? and status='active' limit 1`, [appId, releaseId]);
  return !!registered;
}

// GAP-092: SC-003 calls this during usable-launch confirmation, before
// funding is consumed — a learner's stored progress row is brought forward
// to the release's declared schema version, or the whole confirmation is
// blocked (LearnerSessionError bubbles PROGRESS_SCHEMA_MIGRATION_PATH_MISSING
// up, so nothing is funded against progress the app can no longer read).
// PR-004: fails closed on integrity first (rule 33), and on success writes
// a per-learner migration receipt (learner_progress_migration_receipts) —
// the concrete evidence rules 12/14/15 validate against, since the
// app-wide app_progress_schema_migrations transform registry alone can't
// prove what actually happened to this specific learner's row.
export async function migrateLearnerProgressToReleaseSchema(
  input: { appId: string; learnerId: string; releaseId: string; environment: string; now: Date },
) {
  const db = resolveDbClient();
  const target = await db.get<{ version: number | null }>(`select max(schema_version) as version from app_progress_schemas
    where app_id=? and release_id=? and status='active'`, [input.appId, input.releaseId]);
  if (!target || target.version === null) return; // this release never registered a progress schema — nothing to gate.
  const gate = await validateProgressIntegrity({ learnerId: input.learnerId, appId: input.appId,
    environment: input.environment, reason: "write", now: input.now });
  if (gate.mutationBlocked) {
    throw new ProgressSchemaRegistryError(gate.classification === "unreadable_corrupt"
      ? "PROGRESS_INTEGRITY_UNREADABLE" : "PROGRESS_INTEGRITY_MUTATION_BLOCKED");
  }
  return db.transaction(async(tx)=>{
    const row=await tx.get<{progress_version:number;schema_version:number;current_state_json:string|null}>(
      `select progress_version,schema_version,current_state_json from learner_app_progress where learner_id=? and app_id=?`,
      [input.learnerId,input.appId]);
    if(!row||row.schema_version===target.version)return;
    const currentState=row.current_state_json?JSON.parse(row.current_state_json):null;
    const migrated=await migrateProgressStateWithClient(tx,input.appId,row.schema_version,target.version!,currentState);
    const serialized=JSON.stringify(migrated);
    const stateHash=computeCanonicalStateHash({learnerId:input.learnerId,appId:input.appId,
      environment:input.environment,progressVersion:row.progress_version,schemaVersion:target.version!,serializedState:serialized});
    const receiptId=randomUUID();
    const receipt=await tx.run(`insert into learner_progress_migration_receipts(id,learner_id,app_id,release_id,
      from_schema_version,to_schema_version,progress_version,state_hash_after,migrated_at) values(?,?,?,?,?,?,?,?,?)
      on conflict(learner_id,app_id,release_id,to_schema_version) do nothing`,
    [receiptId,input.learnerId,input.appId,input.releaseId,row.schema_version,target.version!,row.progress_version,
      stateHash,input.now.toISOString()]);
    if(receipt.changes===0){
      const winner=await tx.get<{schema_version:number}>(`select schema_version from learner_app_progress
        where learner_id=? and app_id=?`,[input.learnerId,input.appId]);
      if(winner?.schema_version===target.version)return;
      throw new ProgressSchemaRegistryError("PROGRESS_SCHEMA_MIGRATION_CONFLICT");
    }
    const updated=await tx.run(`update learner_app_progress set schema_version=?,current_state_json=?,app_state=?,state_hash=?,
      last_migration_receipt_id=?,updated_at=? where learner_id=? and app_id=? and progress_version=? and schema_version=?`,
    [target.version!,serialized,serialized,stateHash,receiptId,input.now.toISOString(),input.learnerId,input.appId,
      row.progress_version,row.schema_version]);
    if(updated.changes!==1)throw new ProgressSchemaRegistryError("PROGRESS_SCHEMA_MIGRATION_CONFLICT");
  });
}

// GAP-037/059: the AR-002 release-promotion gate. Every schema_version
// still present among this app's existing learner progress rows must have
// both a forward path to the release's schema version and a rollback path
// back — a version bump that only migrates forward is not release-safe.
export async function assertReleaseSchemaCompatibility(appId: string, releaseId: string, now: Date) {
  const db = resolveDbClient();
  const registered = await db.get<{ version: number | null }>(`select max(schema_version) as version from app_progress_schemas
    where app_id=? and release_id=? and status='active'`, [appId, releaseId]);
  if (!registered || registered.version === null) return; // this release never registered a progress schema — nothing to gate.
  const targetVersion = registered.version;
  const existingVersions = await db.all<{ version: number }>(
    `select distinct schema_version as version from learner_app_progress where app_id=?`, [appId]);
  for (const { version } of existingVersions) {
    if (version === targetVersion) continue;
    if (!(await hasMigrationPath(appId, version, targetVersion)) || !(await hasMigrationPath(appId, targetVersion, version))) {
      throw new ProgressSchemaRegistryError("RELEASE_PROGRESS_SCHEMA_INCOMPATIBLE");
    }
  }
  void now;
}

// PR-003: the standard app-owned progress summary contract, independent of
// any one app's own opaque state schema.
export type ProgressSummary = {
  currentLevel: string; efficiencyStars: number; milestone: string | null; nextDestination: string;
  motivationProgress?: import("@/lib/progress-motivation/contracts").MotivationProgress;
};

export function validateProgressSummary(value: unknown): ProgressSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID");
  const { currentLevel, efficiencyStars, milestone, nextDestination, motivationProgress, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID");
  if (typeof currentLevel !== "string" || !currentLevel || currentLevel.length > 200)
    throw new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID");
  if (!Number.isInteger(efficiencyStars) || (efficiencyStars as number) < 0 || (efficiencyStars as number) > 5)
    throw new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID");
  if (milestone !== null && (typeof milestone !== "string" || milestone.length > 200))
    throw new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID");
  if (typeof nextDestination !== "string" || !nextDestination || nextDestination.length > 200)
    throw new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID");
  try {
    return validateProgressSummaryWithMotivation({ currentLevel, efficiencyStars: efficiencyStars as number,
      milestone: milestone as string | null, nextDestination }, motivationProgress);
  } catch (error) {
    if (error instanceof ProgressMotivationValidationError) throw new ProgressSchemaRegistryError(error.code);
    throw error;
  }
}

