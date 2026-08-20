import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";
import { computeCanonicalStateHash, ProgressIntegrityError, validateProgressIntegrity } from "@/lib/progress-integrity/service";
import { applyIncidentAction, getProgressIntegrityHealth, getSafeIncident } from "@/lib/progress-integrity/incidents";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";

const now = new Date("2026-08-10T10:00:00.000Z");
const appId = "app-1";
const releaseId = "release-1";
const environment = "production";
let adminId: string;

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  adminId = ensureBootstrapPlatformAdmin(now);
});

async function createLearnerFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr004inc-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  return (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09")).learner;
}

function objectSchema() {
  return JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
}

function insertProgressRow(learnerId: string, opts: { progressVersion?: number; schemaVersion?: number;
  state?: unknown; summaryBasedOnVersion?: number | null; badHash?: boolean } = {}) {
  const progressVersion = opts.progressVersion ?? 1;
  const schemaVersion = opts.schemaVersion ?? 1;
  const state = opts.state ?? { level: "l1" };
  const serialized = JSON.stringify(state);
  const hash = opts.badHash ? "tampered-hash" : computeCanonicalStateHash({ learnerId, appId, environment,
    progressVersion, schemaVersion, serializedState: serialized });
  const summaryJson = opts.summaryBasedOnVersion !== undefined && opts.summaryBasedOnVersion !== null
    ? JSON.stringify({ currentLevel: "L1", efficiencyStars: 1, milestone: null, nextDestination: "L2" }) : null;
  getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,state_hash,
    progress_summary_json,progress_summary_based_on_version,updated_at) values(?,?,?,?,?,?,?,?,?)`)
    .run(learnerId, appId, schemaVersion, serialized, progressVersion, hash, summaryJson, opts.summaryBasedOnVersion ?? null, now.toISOString());
}

async function corruptFixture() {
  const learner = await createLearnerFixture();
  registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
  insertProgressRow(learner.id, { badHash: true });
  const validation = validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
  return { learner, incidentId: validation.incidentId! };
}

async function repairableMetadataFixture() {
  const learner = await createLearnerFixture();
  registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
  insertProgressRow(learner.id, { progressVersion: 2, summaryBasedOnVersion: 5 });
  const validation = validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
  return { learner, incidentId: validation.incidentId! };
}

async function legacyReadOnlySafeFixture() {
  const learner = await createLearnerFixture();
  registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: objectSchema(), now });
  registerProgressSchema({ appId, releaseId, schemaVersion: 2, schemaJson: objectSchema(), now });
  insertProgressRow(learner.id, { schemaVersion: 2 });
  const validation = validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
  return { learner, incidentId: validation.incidentId! };
}

describe("PR-004 dedup: exactly one active incident per learner+app", () => {
  it("aggregates a second detection onto the existing open incident instead of creating a duplicate", async () => {
    const { learner, incidentId } = await corruptFixture();
    const second = validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(second.incidentId).toBe(incidentId);
    const count = getDb().prepare(`select count(*) as n from progress_integrity_incidents where learner_id=? and app_id=?`)
      .get(learner.id, appId) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("PR-004 getSafeIncident", () => {
  it("returns a safe view with no raw progress fields and the full action list while open", async () => {
    const { incidentId } = await corruptFixture();
    const incident = await getSafeIncident(incidentId);
    expect(incident.classification).toBe("unreadable_corrupt");
    expect(incident.status).toBe("open");
    expect(incident.allowedActions).toContain("revalidate");
    expect(incident.allowedActions).toContain("open_disaster_recovery_case");
    expect(JSON.stringify(incident)).not.toMatch(/current_state|currentState|"level"/);
  });

  it("throws PROGRESS_INTEGRITY_INCIDENT_NOT_FOUND for an unknown id", async () => {
    await expect(getSafeIncident("does-not-exist")).rejects.toThrowError(new ProgressIntegrityError("PROGRESS_INTEGRITY_INCIDENT_NOT_FOUND"));
  });

  it("returns no allowed actions once an incident is resolved", async () => {
    const { incidentId } = await repairableMetadataFixture();
    getDb().prepare(`update learner_app_progress set progress_summary_based_on_version=2 where app_id=?`).run(appId);
    await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "resolve-1", now });
    expect((await getSafeIncident(incidentId)).allowedActions).toEqual([]);
  });
});

describe("PR-004 applyIncidentAction", () => {
  it("throws PROGRESS_INTEGRITY_INCIDENT_VERSION_CONFLICT on a stale expectedVersion", async () => {
    const { incidentId } = await corruptFixture();
    await expect(applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 999,
      idempotencyKey: "k1", now })).rejects.toThrowError(new ProgressIntegrityError("PROGRESS_INTEGRITY_INCIDENT_VERSION_CONFLICT"));
  });

  it("replays an idempotent call with the same incidentId+idempotencyKey instead of re-acting", async () => {
    const { incidentId } = await corruptFixture();
    const first = await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "replay-1", now });
    const second = await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "replay-1", now });
    expect(second).toEqual(first);
  });

  it("rejects an idempotency key reused for a different action", async () => {
    const { incidentId } = await corruptFixture();
    await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "shared-key", now });
    await expect(applyIncidentAction({ incidentId, action: "resolve_false_positive", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "shared-key", reasonCategory: "false_alarm", now }))
      .rejects.toThrowError(new ProgressIntegrityError("IDEMPOTENCY_KEY_REUSED"));
  });

  it("revalidate on a still-corrupt row reports still-blocked and leaves the incident open", async () => {
    const { incidentId } = await corruptFixture();
    const result = await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "k1", now });
    expect(result.result).toBe("applied");
    expect(result.resultCode).toBe("REVALIDATION_STILL_BLOCKED");
    expect(result.integrityState).toBe("unreadable_corrupt");
    expect((await getSafeIncident(incidentId)).status).toBe("open");
  });

  it("revalidate rule 65: is the only path that can move a corrupt row back to healthy, once the underlying data is fixed", async () => {
    const { learner, incidentId } = await corruptFixture();
    const fixedState = JSON.stringify({ level: "l1" });
    const fixedHash = computeCanonicalStateHash({ learnerId: learner.id, appId, environment, progressVersion: 1,
      schemaVersion: 1, serializedState: fixedState });
    getDb().prepare(`update learner_app_progress set state_hash=? where learner_id=? and app_id=?`)
      .run(fixedHash, learner.id, appId);
    const result = await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "k1", now });
    expect(result.integrityState).toBe("healthy");
    expect(result.incidentStatus).toBe("resolved_repaired");
    expect((await getSafeIncident(incidentId)).status).toBe("resolved_repaired");
  });

  it("retry_safe_metadata_repair is rejected as not-applicable on a corrupt (not repairable) incident", async () => {
    const { incidentId } = await corruptFixture();
    const result = await applyIncidentAction({ incidentId, action: "retry_safe_metadata_repair", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("PROGRESS_INTEGRITY_ACTION_NOT_APPLICABLE");
    expect((await getSafeIncident(incidentId)).status).toBe("open");
  });

  it("retry_safe_metadata_repair resolves a blocked_repairable_metadata incident once the summary is fixed", async () => {
    const { incidentId } = await repairableMetadataFixture();
    getDb().prepare(`update learner_app_progress set progress_summary_based_on_version=2 where app_id=?`).run(appId);
    const result = await applyIncidentAction({ incidentId, action: "retry_safe_metadata_repair", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("applied");
    expect(result.resultCode).toBe("METADATA_REPAIR_RESOLVED");
    expect(result.integrityState).toBe("healthy");
  });

  it("retry_safe_metadata_repair reports a no_op when nothing about the row actually changed", async () => {
    const { incidentId } = await repairableMetadataFixture();
    const result = await applyIncidentAction({ incidentId, action: "retry_safe_metadata_repair", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("no_op");
    expect(result.resultCode).toBe("METADATA_UNCHANGED");
  });

  it("link_matching_receipt is rejected without a receiptId", async () => {
    const { incidentId } = await legacyReadOnlySafeFixture();
    const result = await applyIncidentAction({ incidentId, action: "link_matching_receipt", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("RECEIPT_ID_REQUIRED");
  });

  it("link_matching_receipt is rejected when the receipt doesn't match the row's current schema version", async () => {
    const { learner, incidentId } = await legacyReadOnlySafeFixture();
    getDb().prepare(`insert into learner_progress_migration_receipts(id,learner_id,app_id,release_id,from_schema_version,
      to_schema_version,progress_version,state_hash_after,migrated_at) values('r1',?,?,?,1,99,1,'h',?)`)
      .run(learner.id, appId, releaseId, now.toISOString());
    const result = await applyIncidentAction({ incidentId, action: "link_matching_receipt", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", receiptId: "r1", now });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("PROGRESS_INTEGRITY_RECEIPT_MISMATCH");
  });

  it("link_matching_receipt links a genuinely matching receipt and resolves the incident", async () => {
    const { learner, incidentId } = await legacyReadOnlySafeFixture();
    getDb().prepare(`insert into learner_progress_migration_receipts(id,learner_id,app_id,release_id,from_schema_version,
      to_schema_version,progress_version,state_hash_after,migrated_at) values('r1',?,?,?,1,2,1,'h',?)`)
      .run(learner.id, appId, releaseId, now.toISOString());
    const result = await applyIncidentAction({ incidentId, action: "link_matching_receipt", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", receiptId: "r1", now });
    expect(result.result).toBe("applied");
    expect(result.resultCode).toBe("RECEIPT_LINKED_RESOLVED");
    expect(result.integrityState).toBe("healthy");
    const row = getDb().prepare(`select last_migration_receipt_id from learner_app_progress where learner_id=? and app_id=?`)
      .get(learner.id, appId) as { last_migration_receipt_id: string };
    expect(row.last_migration_receipt_id).toBe("r1");
  });

  it("resolve_legacy_policy is rejected when the incident isn't a legacy read_only_safe case", async () => {
    const { incidentId } = await corruptFixture();
    const result = await applyIncidentAction({ incidentId, action: "resolve_legacy_policy", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("PROGRESS_INTEGRITY_ACTION_NOT_APPLICABLE");
  });

  it("resolve_legacy_policy acknowledges the legacy row and permanently suppresses the reflag", async () => {
    const { learner, incidentId } = await legacyReadOnlySafeFixture();
    const result = await applyIncidentAction({ incidentId, action: "resolve_legacy_policy", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("applied");
    expect(result.incidentStatus).toBe("resolved_legacy_policy");
    expect(result.integrityState).toBe("healthy");
    const revalidated = validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
    expect(revalidated.classification).toBe("healthy");
    expect(revalidated.incidentId).toBeNull();
  });

  it("open_disaster_recovery_case records the routing decision without altering integrity_state", async () => {
    const { incidentId } = await corruptFixture();
    const result = await applyIncidentAction({ incidentId, action: "open_disaster_recovery_case", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("applied");
    expect(result.incidentStatus).toBe("routed_disaster_recovery");
    expect(result.integrityState).toBe("unreadable_corrupt");
    const incident = await getSafeIncident(incidentId);
    expect(incident.workflowRoute).toBe("disaster_recovery");
    expect(incident.status).toBe("routed_disaster_recovery");
  });

  it("resolve_false_positive requires a reason category", async () => {
    const { incidentId } = await corruptFixture();
    const result = await applyIncidentAction({ incidentId, action: "resolve_false_positive", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", now });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("REASON_CATEGORY_REQUIRED");
  });

  it("resolve_false_positive closes the incident without forcing integrity_state to healthy", async () => {
    const { incidentId } = await corruptFixture();
    const result = await applyIncidentAction({ incidentId, action: "resolve_false_positive", actorAdminId: adminId,
      expectedVersion: 1, idempotencyKey: "k1", reasonCategory: "known_test_data", now });
    expect(result.result).toBe("applied");
    expect(result.incidentStatus).toBe("resolved_false_positive");
    // Rule 65: an operator can't bless corrupt data as healthy by fiat —
    // the underlying row is still hash-mismatched.
    expect(result.integrityState).toBe("unreadable_corrupt");
  });

  it("every action row records actor, prior/new integrity state and prior/new incident status (rule 66)", async () => {
    const { incidentId } = await corruptFixture();
    await applyIncidentAction({ incidentId, action: "revalidate", actorAdminId: adminId, expectedVersion: 1,
      idempotencyKey: "k1", now });
    const action = getDb().prepare(`select * from progress_integrity_incident_actions where incident_id=?`).get(incidentId) as
      Record<string, unknown>;
    expect(action.actor_admin_id).toBe(adminId);
    expect(action.prior_integrity_state).toBe("unreadable_corrupt");
    expect(action.prior_incident_status).toBe("open");
    expect(action.evidence_refs).toBe("[]");
    // No raw progress fields ever persisted on the action row.
    expect(Object.keys(action as object)).not.toContain("current_state_json");
  });
});

describe("PR-004 getProgressIntegrityHealth", () => {
  it("reports aggregate counts and classifications with no learner reference", async () => {
    await corruptFixture();
    await repairableMetadataFixture();
    const health = await getProgressIntegrityHealth(appId, environment);
    expect(health.countsByStatus.open).toBe(2);
    expect(health.openCountsByClassification.unreadable_corrupt).toBe(1);
    expect(health.openCountsByClassification.blocked_repairable_metadata).toBe(1);
    expect(health.openIncidentCount).toBe(2);
    expect(JSON.stringify(health)).not.toMatch(/learner_id|learnerId/);
  });

  it("returns zero counts for an app with no incidents", async () => {
    const health = await getProgressIntegrityHealth("app-1", environment);
    expect(health.openIncidentCount).toBe(0);
    expect(health.oldestOpenIncidentAgeSeconds).toBeNull();
  });
});
