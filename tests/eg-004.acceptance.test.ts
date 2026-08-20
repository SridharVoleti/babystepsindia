// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { AppProgressError, saveCheckpoint, writeProgressSummary, type AppProgressContext }
  from "@/lib/app-progress/service";
import { validateProgressSummary } from "@/lib/progress-schema-registry/service";
import { validateProgressSummaryWithMotivation } from "@/lib/progress-motivation/validation";

const now = new Date("2026-08-13T10:00:00.000Z");
const appId = "app-eg004";
const releaseId = "release-eg004";
const sessionId = "session-eg004";
const principalId = "principal-eg004";
let context: AppProgressContext;

const core = { currentLevel: "Level 3", efficiencyStars: 3, milestone: "Halfway",
  nextDestination: "Level 4" };
const summary = (motivationProgress: unknown) => ({ ...core, motivationProgress });

function expectInvalid(value: unknown, code = "PROGRESS_MOTIVATION_INVALID") {
  try { validateProgressSummary(value); throw new Error("expected rejection"); }
  catch (error) { expect(error).toMatchObject({ code }); }
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`eg004-${randomUUID()}@example.com`, "CorrectHorse1!");
  const learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-13")).learner.id;
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status)
    values(?,?,'Progress App','active')`).run(appId, appId);
  const manifest = { manifestVersion: 1, appKey: appId, launchPath: "/launch", returnPath: "/return",
    identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0",
    motivation: { motivationContractVersion: "1.0",
      supportedDisplayTypes: ["steps", "percentage", "label", "none"] } };
  getDb().prepare(`insert into app_releases(id,app_id,source_repository,source_commit_sha,dependency_lock_hash,
    build_input_hash,artifact_digest,manifest_json,gate_results_json,readable_schema_versions_json,status,
    created_by_ci_principal) values(?,?,'repo',?,'lock','input','digest',?,'{}','[1]','verified','ci')`)
    .run(releaseId, appId, "e".repeat(40), JSON.stringify(manifest));
  getDb().prepare(`insert into app_service_principals
    (id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until)
    values(?,?,'production','deployment-eg004','eg004-client','key','active',
      '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z')`).run(principalId, appId);
  getDb().prepare(`insert into learner_sessions
    (id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,weekly_slot_number,source,
     status,funding_state,schedule_authorization_id,started_at,usable_launch_established_at,hard_expires_at,
     resume_token_hash,deployment_environment,release_id,current_level_key,current_lesson_key,created_at,updated_at)
    values(?,?,?,?,?,'2026-W33','Asia/Kolkata',1,'normal','active','consumed','schedule',?,?,?,'hash',
      'production',?,'level-1','lesson-1',?,?)`)
    .run(sessionId, learnerId, appId, user.id, "device-eg004", now.toISOString(), now.toISOString(),
      "2026-08-13T11:00:00.000Z", releaseId, now.toISOString(), now.toISOString());
  getDb().prepare(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values('grant-eg004',?,?,?,'production','deployment-eg004',?,?,'["progress.read","progress.write",
      "progress.summary.write"]','1.0',1,'active','2026-08-13T11:00:00.000Z',?,?)`)
    .run(sessionId, learnerId, appId, releaseId, principalId, now.toISOString(), now.toISOString());
  const schema = JSON.stringify({ type: "object", required: ["board"], additionalProperties: false,
    properties: { board: { type: "string" } } });
  getDb().prepare(`insert into app_progress_schemas(app_id,release_id,schema_version,schema_json,schema_digest,status,created_at)
    values(?,?,?,?,?,'active',?)`).run(appId, releaseId, 1, schema,
      createHash("sha256").update(schema).digest("hex"), now.toISOString());
  context = { grantId: "grant-eg004", principalId, learnerSessionId: sessionId, learnerId, appId };
  saveCheckpoint(context, { expectedProgressVersion: 0, checkpointSequence: 1, stateSchemaVersion: 1,
    currentLevelKey: "level-1", currentLessonKey: "lesson-1", currentState: { board: "start" },
    checkpointIdempotencyKey: "checkpoint-eg004", progressSummary: core }, now);
});

describe("EG-004 app-defined motivation progress — 48 acceptance cases", () => {
  it.each([
    ["AT-EG-004-01", { displayType: "steps", stepPosition: 3, stepCount: 7 }],
    ["AT-EG-004-02", { displayType: "percentage", percentageValue: 42.5 }],
    ["AT-EG-004-03", { displayType: "label", progressLabel: "Building confidence" }],
    ["AT-EG-004-04", { displayType: "none" }],
  ])("%s accepts the exact supported display shape", (_id, motivation) => {
    expect(validateProgressSummary(summary(motivation))).toEqual(summary(motivation));
  });

  it("AT-EG-004-05 accepts the optional app-authored message", () => {
    expect(validateProgressSummary(summary({ displayType: "none", motivationalMessage: "Keep going!" })))
      .toHaveProperty("motivationProgress.motivationalMessage", "Keep going!");
  });
  it("AT-EG-004-06 keeps a PR-003 summary without motivation backward compatible", () => {
    expect(validateProgressSummary(core)).toEqual(core);
  });
  it("AT-EG-004-07 accepts the first ordinal step", () => {
    expect(validateProgressSummary(summary({ displayType: "steps", stepPosition: 1, stepCount: 7 })))
      .toHaveProperty("motivationProgress.stepPosition", 1);
  });
  it("AT-EG-004-08 accepts the final ordinal step", () => {
    expect(validateProgressSummary(summary({ displayType: "steps", stepPosition: 7, stepCount: 7 })))
      .toHaveProperty("motivationProgress.stepPosition", 7);
  });
  it.each([["AT-EG-004-09", 0], ["AT-EG-004-10", 100], ["AT-EG-004-11", 42.5]])(
    "%s preserves an app-supplied percentage exactly", (_id, value) => {
      expect(validateProgressSummary(summary({ displayType: "percentage", percentageValue: value })))
        .toHaveProperty("motivationProgress.percentageValue", value);
    });
  it("AT-EG-004-12 preserves Unicode without normalization", () => {
    const label = "Ａpp-defined progress";
    expect(validateProgressSummary(summary({ displayType: "label", progressLabel: label })))
      .toHaveProperty("motivationProgress.progressLabel", label);
  });

  it.each([
    ["AT-EG-004-13", { displayType: "gauge" }],
    ["AT-EG-004-14", { progressLabel: "Missing type" }],
    ["AT-EG-004-15", { displayType: "steps", stepPosition: 0, stepCount: 7 }],
    ["AT-EG-004-16", { displayType: "steps", stepPosition: 1, stepCount: 0 }],
    ["AT-EG-004-17", { displayType: "steps", stepPosition: 8, stepCount: 7 }],
    ["AT-EG-004-18", { displayType: "steps", stepPosition: 1.5, stepCount: 7 }],
    ["AT-EG-004-19", { displayType: "steps", stepPosition: 1, stepCount: 7.5 }],
    ["AT-EG-004-20", { displayType: "steps", stepPosition: 3, stepCount: 7, percentageValue: 43 }],
    ["AT-EG-004-21", { displayType: "percentage" }],
    ["AT-EG-004-22", { displayType: "percentage", percentageValue: -1 }],
    ["AT-EG-004-23", { displayType: "percentage", percentageValue: 101 }],
    ["AT-EG-004-24", { displayType: "percentage", percentageValue: Number.NaN }],
    ["AT-EG-004-25", { displayType: "label" }],
    ["AT-EG-004-26", { displayType: "label", progressLabel: "Good", stepCount: 2 }],
    ["AT-EG-004-27", { displayType: "none", progressLabel: "Invented" }],
    ["AT-EG-004-28", { displayType: "label", progressLabel: "" }],
    ["AT-EG-004-29", { displayType: "label", progressLabel: "<b>unsafe</b>" }],
    ["AT-EG-004-30", { displayType: "label", progressLabel: "https://example.test" }],
    ["AT-EG-004-31", { displayType: "label", progressLabel: "unsafe\u0001" }],
    ["AT-EG-004-32", { displayType: "steps", stepPosition: 1, stepCount: 2, currentStepKey: "k".repeat(81) }],
    ["AT-EG-004-33", { displayType: "steps", stepPosition: 1, stepCount: 2, currentStepLabel: "x".repeat(101) }],
    ["AT-EG-004-34", { displayType: "steps", stepPosition: 1, stepCount: 2, nextStepLabel: "x".repeat(121) }],
    ["AT-EG-004-35", { displayType: "label", progressLabel: "x".repeat(141) }],
    ["AT-EG-004-36", { displayType: "none", motivationalMessage: "x".repeat(161) }],
  ])("%s rejects an invalid or mixed app-owned representation", (_id, motivation) => expectInvalid(summary(motivation)));

  it("AT-EG-004-37 enforces the 4 KiB amended summary limit in UTF-8 bytes", () => {
    expect(() => validateProgressSummaryWithMotivation({ ...core, currentLevel: "界".repeat(1400) },
      { displayType: "none" })).toThrowError(expect.objectContaining({ code: "PROGRESS_SUMMARY_TOO_LARGE" }));
  });
  it("AT-EG-004-38 rejects expansion of the core PR-003 authority", () => {
    expectInvalid({ ...core, masteryScore: 90 }, "PROGRESS_SUMMARY_INVALID");
  });
  it("AT-EG-004-39 rejects raw or derived fields inside motivation", () => {
    expectInvalid(summary({ displayType: "label", progressLabel: "Good", rawAnswers: [1, 2] }));
  });

  it("AT-EG-004-40 writes the exact motivation into the existing summary row", () => {
    const progressSummary = summary({ displayType: "steps", stepPosition: 3, stepCount: 7,
      currentStepLabel: "Openings", nextStepLabel: "Tactics" });
    expect(writeProgressSummary(context, { basedOnProgressVersion: 1, progressSummary,
      summaryIdempotencyKey: "summary-40" }, now)).toMatchObject({ progressSummary });
  });
  it("AT-EG-004-41 never bumps or replaces the app progress authority", () => {
    writeProgressSummary(context, { basedOnProgressVersion: 1,
      progressSummary: summary({ displayType: "percentage", percentageValue: 33 }),
      summaryIdempotencyKey: "summary-41" }, now);
    expect(getDb().prepare(`select progress_version,current_state_json,current_level_key,current_lesson_key
      from learner_app_progress`).get()).toMatchObject({ progress_version: 1, current_state_json: '{"board":"start"}',
      current_level_key: "level-1", current_lesson_key: "lesson-1" });
  });
  it("AT-EG-004-42 replays the exact write exactly once", () => {
    const input = { basedOnProgressVersion: 1, progressSummary: summary({ displayType: "label",
      progressLabel: "Ready for puzzles" }), summaryIdempotencyKey: "summary-42" };
    expect(writeProgressSummary(context, input, now)).toEqual(writeProgressSummary(context, input, now));
    expect(getDb().prepare("select progress_summary_version from learner_app_progress").get())
      .toMatchObject({ progress_summary_version: 2 });
  });
  it("AT-EG-004-43 rejects conflicting idempotency reuse", () => {
    writeProgressSummary(context, { basedOnProgressVersion: 1, progressSummary: summary({ displayType: "none" }),
      summaryIdempotencyKey: "summary-43" }, now);
    expect(() => writeProgressSummary(context, { basedOnProgressVersion: 1,
      progressSummary: summary({ displayType: "label", progressLabel: "Changed" }),
      summaryIdempotencyKey: "summary-43" }, now)).toThrowError(new AppProgressError("IDEMPOTENCY_KEY_REUSED"));
  });
  it("AT-EG-004-44 rejects a stale based-on version and retains the prior summary", () => {
    expect(() => writeProgressSummary(context, { basedOnProgressVersion: 2,
      progressSummary: summary({ displayType: "label", progressLabel: "Stale" }),
      summaryIdempotencyKey: "summary-44" }, now)).toThrowError(new AppProgressError("PROGRESS_VERSION_CONFLICT"));
    expect(getDb().prepare("select progress_summary_json from learner_app_progress").get())
      .toMatchObject({ progress_summary_json: JSON.stringify(core) });
  });
  it("AT-EG-004-45 rejects a display type the current release did not declare", () => {
    const manifest = JSON.parse((getDb().prepare("select manifest_json from app_releases").get() as {manifest_json:string}).manifest_json);
    manifest.motivation.supportedDisplayTypes = ["steps"];
    getDb().prepare("update app_releases set manifest_json=?").run(JSON.stringify(manifest));
    expect(() => writeProgressSummary(context, { basedOnProgressVersion: 1,
      progressSummary: summary({ displayType: "percentage", percentageValue: 50 }),
      summaryIdempotencyKey: "summary-45" }, now))
      .toThrowError(new AppProgressError("PROGRESS_MOTIVATION_TYPE_UNSUPPORTED"));
  });
  it("AT-EG-004-46 retains the prior summary after invalid input and permits a corrected retry", () => {
    expect(() => writeProgressSummary(context, { basedOnProgressVersion: 1,
      progressSummary: summary({ displayType: "percentage", percentageValue: 120 }),
      summaryIdempotencyKey: "summary-46" }, now)).toThrowError(new AppProgressError("PROGRESS_MOTIVATION_INVALID"));
    const corrected = summary({ displayType: "percentage", percentageValue: 20 });
    expect(writeProgressSummary(context, { basedOnProgressVersion: 1, progressSummary: corrected,
      summaryIdempotencyKey: "summary-46" }, now)).toMatchObject({ progressSummary: corrected });
  });
  it("AT-EG-004-47 accepts motivation atomically with a checkpoint and binds it to the new version", () => {
    const progressSummary = summary({ displayType: "steps", stepPosition: 4, stepCount: 7 });
    const result = saveCheckpoint(context, { expectedProgressVersion: 1, checkpointSequence: 2,
      stateSchemaVersion: 1, currentLevelKey: "level-1", currentLessonKey: "lesson-1",
      currentState: { board: "next" }, checkpointIdempotencyKey: "checkpoint-47", progressSummary }, now);
    expect(result).toMatchObject({ progressVersion: 2, progressSummary, progressSummaryBasedOnVersion: 2 });
  });
  it("AT-EG-004-48 creates no second progress table, XP, level, rank, or cross-app aggregate", () => {
    const tables = (getDb().prepare("select name from sqlite_master where type='table'").all() as {name:string}[])
      .map((row) => row.name).filter((name) => /motivation|xp|ranking|global_progress/i.test(name));
    expect(tables).toEqual([]);
    const columns = (getDb().prepare("pragma table_info(learner_app_progress)").all() as {name:string}[])
      .map((row) => row.name).join(" ");
    expect(columns).not.toMatch(/xp|rank|global|average|mastery/i);
  });
});
