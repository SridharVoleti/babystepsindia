import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";
import {
  computeCanonicalStateHash,
  ProgressIntegrityError,
  validateProgressIntegrity,
} from "@/lib/progress-integrity/service";

const now = new Date("2026-08-10T10:00:00.000Z");
const appId = "app-1";
const releaseId = "release-1";
const environment = "production";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
});

async function createLearnerFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr004-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  return (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner;
}

function objectSchema() {
  return JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
}

function insertHealthyProgressRow(learnerId: string, opts: { progressVersion?: number; schemaVersion?: number;
  state?: unknown; summaryBasedOnVersion?: number | null } = {}) {
  const progressVersion = opts.progressVersion ?? 1;
  const schemaVersion = opts.schemaVersion ?? 1;
  const state = opts.state ?? { level: "l1" };
  const serialized = JSON.stringify(state);
  const hash = computeCanonicalStateHash({ learnerId, appId, environment, progressVersion, schemaVersion, serializedState: serialized });
  const summaryJson = opts.summaryBasedOnVersion !== undefined && opts.summaryBasedOnVersion !== null
    ? JSON.stringify({ currentLevel: "L1", efficiencyStars: 1, milestone: null, nextDestination: "L2" }) : null;
  getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,state_hash,
    progress_summary_json,progress_summary_based_on_version,updated_at) values(?,?,?,?,?,?,?,?,?)`)
    .run(learnerId, appId, schemaVersion, serialized, progressVersion, hash, summaryJson, opts.summaryBasedOnVersion ?? null, now.toISOString());
  return { serialized, hash };
}

describe("PR-004 validateProgressIntegrity", () => {
  it("classifies a learner/app pair with no progress row yet as healthy", async () => {
    const learner = await createLearnerFixture();
    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("healthy");
    expect(result.mutationBlocked).toBe(false);
    expect(result.readSafe).toBe(true);
    expect(result.incidentId).toBeNull();
  });

  it("classifies a healthy, correctly-hashed, schema-registered row as healthy", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id);
    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("healthy");
    expect(result.mutationBlocked).toBe(false);
    expect(result.readSafe).toBe(true);
  });

  it("classifies a hash-tampered row as unreadable_corrupt, blocks reads and writes, and opens an incident", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id);
    getDb().prepare(`update learner_app_progress set current_state_json=? where learner_id=? and app_id=?`)
      .run(JSON.stringify({ level: "tampered" }), learner.id, appId);

    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("unreadable_corrupt");
    expect(result.mutationBlocked).toBe(true);
    expect(result.readSafe).toBe(false);
    expect(result.issueCodes).toContain("HASH_MISMATCH");
    expect(result.incidentId).not.toBeNull();

    const incident = getDb().prepare(`select * from progress_integrity_incidents where id=?`).get(result.incidentId) as
      { classification: string; status: string; learner_id: string; app_id: string };
    expect(incident.classification).toBe("unreadable_corrupt");
    expect(incident.status).toBe("open");
    expect(incident.learner_id).toBe(learner.id);
    expect(incident.app_id).toBe(appId);
  });

  it("classifies an unregistered schema version as unreadable_corrupt", async () => {
    const learner = await createLearnerFixture();
    // No registerProgressSchema call at all for schemaVersion 1.
    insertHealthyProgressRow(learner.id);
    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("unreadable_corrupt");
    expect(result.issueCodes).toContain("SCHEMA_VERSION_UNREGISTERED");
  });

  it("classifies a summary ahead of current progress_version as blocked_repairable_metadata", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id, { progressVersion: 2, summaryBasedOnVersion: 5 });
    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("blocked_repairable_metadata");
    expect(result.issueCodes).toContain("SUMMARY_VERSION_AHEAD");
    expect(result.readSafe).toBe(true);
  });

  it("classifies a summary behind current progress_version as read_only_safe", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id, { progressVersion: 3, summaryBasedOnVersion: 1 });
    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("read_only_safe");
    expect(result.issueCodes).toContain("SUMMARY_STALE");
    // Rule 26: stale-summary-only is a benign auxiliary inconsistency, not
    // an incident-worthy issue on its own.
    expect(result.incidentId).toBeNull();
  });

  it("treats a schema-version-bumped row with no migration receipt and no app migration history as legacy read_only_safe", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    await registerProgressSchema({ appId, releaseId, schemaVersion: 2, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id, { schemaVersion: 2 });
    const result = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(result.classification).toBe("read_only_safe");
    expect(result.issueCodes).toContain("LEGACY_RECEIPT_MISSING_UNENFORCED");
    // Unlike plain summary staleness, this is a real policy decision an
    // operator needs to make (rule 63's resolve_legacy_policy action) —
    // it does open an incident.
    expect(result.incidentId).not.toBeNull();
  });

  it("throws PROGRESS_INTEGRITY_VERSION_CONFLICT when expectedIntegrityVersion is stale", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id);
    await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    await expect(validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read",
      expectedIntegrityVersion: 999, now })).rejects.toThrowError(new ProgressIntegrityError("PROGRESS_INTEGRITY_VERSION_CONFLICT"));
  });

  it("replays an idempotent call with the same requester+idempotencyKey instead of re-evaluating", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id);
    const first = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read",
      requesterPrincipalId: "req-1", idempotencyKey: "idem-1", now });
    getDb().prepare(`update learner_app_progress set current_state_json=? where learner_id=? and app_id=?`)
      .run(JSON.stringify({ level: "changed-after-first-call" }), learner.id, appId);
    const second = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read",
      requesterPrincipalId: "req-1", idempotencyKey: "idem-1", now });
    expect(second).toEqual(first);
  });

  it("bumps integrity_version only when the classification or issue codes actually change", async () => {
    const learner = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learner.id);
    const first = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    const second = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(second.integrityVersion).toBe(first.integrityVersion);

    getDb().prepare(`update learner_app_progress set current_state_json=? where learner_id=? and app_id=?`)
      .run(JSON.stringify({ level: "tampered" }), learner.id, appId);
    const third = await validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(third.integrityVersion).toBe(first.integrityVersion + 1);
  });

  it("never scans more than this learner+app's own row (bounded, single-row lookups)", async () => {
    const learnerA = await createLearnerFixture();
    const learnerB = await createLearnerFixture();
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
    insertHealthyProgressRow(learnerA.id);
    getDb().prepare(`update learner_app_progress set current_state_json=? where learner_id=? and app_id=?`)
      .run(JSON.stringify({ level: "tampered" }), learnerA.id, appId);
    insertHealthyProgressRow(learnerB.id);

    const resultA = await validateProgressIntegrity({ learnerId: learnerA.id, appId, environment, reason: "read", now });
    const resultB = await validateProgressIntegrity({ learnerId: learnerB.id, appId, environment, reason: "read", now });
    expect(resultA.classification).toBe("unreadable_corrupt");
    expect(resultB.classification).toBe("healthy");
  });
});

