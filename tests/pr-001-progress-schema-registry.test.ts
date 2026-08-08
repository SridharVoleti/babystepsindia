import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import {
  applyDeclarativeTransform,
  assertReleaseSchemaCompatibility,
  hasMigrationPath,
  migrateLearnerProgressToReleaseSchema,
  migrateProgressState,
  ProgressSchemaRegistryError,
  registerProgressSchema,
  registerSchemaMigration,
  validateProgressSummary,
} from "@/lib/progress-schema-registry/service";

const now = new Date("2026-08-09T10:00:00.000Z");
const appId = "app-1";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
});

async function createLearnerFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr001-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  return createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09").learner;
}

describe("PR-001 declarative transform", () => {
  it("renames, defaults and drops fields at the top level only", () => {
    const result = applyDeclarativeTransform({ oldKey: "value", keep: 1, drop: "gone" }, {
      renameFields: { oldKey: "newKey" }, setDefaults: { added: 42, keep: 999 }, dropFields: ["drop"],
    });
    expect(result).toEqual({ newKey: "value", keep: 1, added: 42 });
  });

  it("leaves non-object state untouched", () => {
    expect(applyDeclarativeTransform("opaque", { setDefaults: { x: 1 } })).toBe("opaque");
    expect(applyDeclarativeTransform(null, { setDefaults: { x: 1 } })).toBeNull();
  });
});

describe("PR-001 migration path walking", () => {
  it("walks a multi-step forward chain and applies each transform in order", () => {
    registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2,
      transform: { renameFields: { level: "currentLevel" } }, now });
    registerSchemaMigration({ appId, fromSchemaVersion: 2, toSchemaVersion: 3,
      transform: { setDefaults: { stars: 0 } }, now });
    const migrated = migrateProgressState(appId, 1, 3, { level: "l1", score: 10 });
    expect(migrated).toEqual({ currentLevel: "l1", score: 10, stars: 0 });
  });

  it("walks backward using the separately-registered rollback transform", () => {
    registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2,
      transform: { renameFields: { level: "currentLevel" } }, now });
    registerSchemaMigration({ appId, fromSchemaVersion: 2, toSchemaVersion: 1,
      transform: { renameFields: { currentLevel: "level" } }, now });
    const rolledBack = migrateProgressState(appId, 2, 1, { currentLevel: "l1" });
    expect(rolledBack).toEqual({ level: "l1" });
  });

  it("throws PROGRESS_SCHEMA_MIGRATION_PATH_MISSING rather than partially migrating", () => {
    registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2, transform: {}, now });
    // No 2->3 migration registered.
    expect(() => migrateProgressState(appId, 1, 3, { a: 1 })).toThrowError(
      new ProgressSchemaRegistryError("PROGRESS_SCHEMA_MIGRATION_PATH_MISSING"));
  });

  it("rejects a non-adjacent migration step registration", () => {
    expect(() => registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 3, transform: {}, now }))
      .toThrowError(new ProgressSchemaRegistryError("SCHEMA_MIGRATION_STEP_INVALID"));
  });

  it("rejects a transform with unknown keys", () => {
    expect(() => registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2,
      transform: { deleteEverything: true }, now })).toThrowError(new ProgressSchemaRegistryError("SCHEMA_TRANSFORM_INVALID"));
  });
});

describe("PR-001/AR-002 release-promotion compatibility gate", () => {
  function schema(version: number) {
    return JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
  }

  it("is a no-op when the release never registered a progress schema", () => {
    expect(() => assertReleaseSchemaCompatibility(appId, "release-none", now)).not.toThrow();
  });

  it("is a no-op when no learner has any progress on this app yet", () => {
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 2, schemaJson: schema(2), now });
    expect(() => assertReleaseSchemaCompatibility(appId, "release-1", now)).not.toThrow();
  });

  it("blocks promotion when an existing learner's schema version has no forward+rollback path to the release's version", async () => {
    const learner = await createLearnerFixture();
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,updated_at) values(?,?,1,?)`)
      .run(learner.id, appId, now.toISOString());
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 2, schemaJson: schema(2), now });
    expect(() => assertReleaseSchemaCompatibility(appId, "release-1", now))
      .toThrowError(new ProgressSchemaRegistryError("RELEASE_PROGRESS_SCHEMA_INCOMPATIBLE"));
  });

  it("allows promotion once both directions are registered for every existing version in use", async () => {
    const learner = await createLearnerFixture();
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,updated_at) values(?,?,1,?)`)
      .run(learner.id, appId, now.toISOString());
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 2, schemaJson: schema(2), now });
    registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2, transform: {}, now });
    registerSchemaMigration({ appId, fromSchemaVersion: 2, toSchemaVersion: 1, transform: {}, now });
    expect(() => assertReleaseSchemaCompatibility(appId, "release-1", now)).not.toThrow();
  });

  it("hasMigrationPath reports true only once both a forward and matching rollback step exist", () => {
    expect(hasMigrationPath(appId, 1, 2)).toBe(false);
    registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2, transform: {}, now });
    expect(hasMigrationPath(appId, 1, 2)).toBe(true);
    expect(hasMigrationPath(appId, 2, 1)).toBe(false);
  });
});

describe("GAP-092: SC-003 usable-launch progress migration", () => {
  function schema(version: number) {
    return JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
  }

  it("migrates a learner's stored progress forward to the release's declared schema version", async () => {
    const learner = await createLearnerFixture();
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,updated_at)
      values(?,?,1,?,?)`).run(learner.id, appId, JSON.stringify({ level: "l1" }), now.toISOString());
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 2, schemaJson: schema(2), now });
    registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2,
      transform: { renameFields: { level: "currentLevel" } }, now });

    migrateLearnerProgressToReleaseSchema({ appId, learnerId: learner.id, releaseId: "release-1", now });

    const row = getDb().prepare("select schema_version,current_state_json from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { schema_version: number; current_state_json: string };
    expect(row.schema_version).toBe(2);
    expect(JSON.parse(row.current_state_json)).toEqual({ currentLevel: "l1" });
  });

  it("throws PROGRESS_SCHEMA_MIGRATION_PATH_MISSING and leaves the stored row untouched when no path is registered", async () => {
    const learner = await createLearnerFixture();
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,updated_at)
      values(?,?,1,?,?)`).run(learner.id, appId, JSON.stringify({ level: "l1" }), now.toISOString());
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 2, schemaJson: schema(2), now });

    expect(() => migrateLearnerProgressToReleaseSchema({ appId, learnerId: learner.id, releaseId: "release-1", now }))
      .toThrowError(new ProgressSchemaRegistryError("PROGRESS_SCHEMA_MIGRATION_PATH_MISSING"));
    const row = getDb().prepare("select schema_version from learner_app_progress where learner_id=? and app_id=?")
      .get(learner.id, appId) as { schema_version: number };
    expect(row.schema_version).toBe(1);
  });

  it("is a no-op when the learner's progress already matches the release's schema version", async () => {
    const learner = await createLearnerFixture();
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,updated_at)
      values(?,?,2,?,?)`).run(learner.id, appId, JSON.stringify({ currentLevel: "l1" }), now.toISOString());
    registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 2, schemaJson: schema(2), now });
    expect(() => migrateLearnerProgressToReleaseSchema({ appId, learnerId: learner.id, releaseId: "release-1", now })).not.toThrow();
  });
});

describe("PR-003 progress summary contract", () => {
  it("accepts a well-formed summary", () => {
    expect(validateProgressSummary({ currentLevel: "Level 3", efficiencyStars: 4, milestone: "Fast learner", nextDestination: "Level 4" }))
      .toEqual({ currentLevel: "Level 3", efficiencyStars: 4, milestone: "Fast learner", nextDestination: "Level 4" });
  });

  it("accepts a null milestone", () => {
    expect(validateProgressSummary({ currentLevel: "L1", efficiencyStars: 0, milestone: null, nextDestination: "L2" }).milestone).toBeNull();
  });

  it("rejects an out-of-range star count", () => {
    expect(() => validateProgressSummary({ currentLevel: "L1", efficiencyStars: 6, milestone: null, nextDestination: "L2" }))
      .toThrowError(new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID"));
  });

  it("rejects unknown fields", () => {
    expect(() => validateProgressSummary({ currentLevel: "L1", efficiencyStars: 1, milestone: null, nextDestination: "L2", extra: true }))
      .toThrowError(new ProgressSchemaRegistryError("PROGRESS_SUMMARY_INVALID"));
  });
});
