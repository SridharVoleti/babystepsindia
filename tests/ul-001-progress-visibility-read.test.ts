import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { readProgressVisibilitySnapshot } from "@/lib/progress-integrity/service";

const appId = "app-1";
const environment = "production";
let learnerId: string;

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  const { user } = await sqliteAuthAdapter.signUp(`ul001-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  learnerId = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09").learner.id;
});

function insertIntegrityRow(state: string, readSafe: 0 | 1) {
  getDb().prepare(`insert into learner_app_progress_integrity(learner_id,app_id,environment,integrity_state,integrity_version,
    canonical_state_hash,issue_codes,mutation_blocked,read_safe,last_validated_at,last_validated_source,created_at,updated_at)
    values(?,?,?,?,0,'hash','[]',?,?,'2026-08-10T00:00:00.000Z','inline_read','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z')`)
    .run(learnerId, appId, environment, state, readSafe === 0 ? 1 : 0, readSafe);
}

describe("readProgressVisibilitySnapshot", () => {
  it("treats a never-validated learner/app pair as safe (matches classifyIntegrity's own no-row default)", () => {
    const snapshot = readProgressVisibilitySnapshot(learnerId, appId);
    expect(snapshot).toEqual({ readSafe: true, classification: "unknown" });
  });

  it("reads read_safe=0 (blocked_conflict) as unsafe", () => {
    insertIntegrityRow("blocked_conflict", 0);
    const snapshot = readProgressVisibilitySnapshot(learnerId, appId);
    expect(snapshot).toEqual({ readSafe: false, classification: "blocked_conflict" });
  });

  it("reads read_safe=0 (unreadable_corrupt) as unsafe", () => {
    insertIntegrityRow("unreadable_corrupt", 0);
    const snapshot = readProgressVisibilitySnapshot(learnerId, appId);
    expect(snapshot).toEqual({ readSafe: false, classification: "unreadable_corrupt" });
  });

  it("reads read_safe=1 for a non-healthy but still-readable classification", () => {
    insertIntegrityRow("read_only_safe", 1);
    const snapshot = readProgressVisibilitySnapshot(learnerId, appId);
    expect(snapshot).toEqual({ readSafe: true, classification: "read_only_safe" });
  });

  it("never writes — receipt/row counts are unchanged before and after", () => {
    insertIntegrityRow("healthy", 1);
    const receiptsBefore = (getDb().prepare(`select count(*) as n from progress_integrity_validation_receipts`).get() as { n: number }).n;
    const integrityRowsBefore = (getDb().prepare(`select count(*) as n from learner_app_progress_integrity`).get() as { n: number }).n;
    readProgressVisibilitySnapshot(learnerId, appId);
    const receiptsAfter = (getDb().prepare(`select count(*) as n from progress_integrity_validation_receipts`).get() as { n: number }).n;
    const integrityRowsAfter = (getDb().prepare(`select count(*) as n from learner_app_progress_integrity`).get() as { n: number }).n;
    expect(receiptsAfter).toBe(receiptsBefore);
    expect(integrityRowsAfter).toBe(integrityRowsBefore);
  });
});
