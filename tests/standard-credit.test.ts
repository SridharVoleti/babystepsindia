import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import {
  StandardCreditError,
  buildStandardAllowance,
  consumeStandardReservation,
  ensureEntitlementPeriodStandardAllocation,
  ensureMonthlyStandardAllocation,
  fundStandardSession,
  releaseStandardReservation,
} from "@/lib/session-credit-standard/service";

const appId = "math-app";
const tz = "Asia/Kolkata";
let learnerId: string;
let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "Math App");
  const { user } = await sqliteAuthAdapter.signUp("standard-credit-parent@example.com", "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: "20000000-0000-4000-8000-000000000001" }, "2026-08-01")).learner.id;
});

function fund(now: Date) {
  return fundStandardSession({ learnerId, appId, timezone: tz, now });
}

describe("SC-002 standard monthly credit batches", () => {
  it("allocates eight credits effective at local month start, expiring end of the following local month", () => {
    const batch = ensureMonthlyStandardAllocation(learnerId, appId, tz, new Date("2026-08-15T09:00:00.000Z"));
    expect(batch).toMatchObject({
      allocation_month: "2026-08-01", granted_count: 8, reserved_count: 0, consumed_count: 0,
      effective_at: "2026-07-31T18:30:00.000Z", expires_at: "2026-09-30T18:29:59.999Z",
    });
  });

  it("is idempotent — repeat/concurrent calls return exactly one batch (AC6/AC8)", () => {
    const now = new Date("2026-08-15T09:00:00.000Z");
    const first = ensureMonthlyStandardAllocation(learnerId, appId, tz, now);
    const second = ensureMonthlyStandardAllocation(learnerId, appId, tz, new Date("2026-08-20T09:00:00.000Z"));
    expect(second).toEqual(first);
    expect(getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get()).toMatchObject({ n: 1 });
  });

  it("does not create eight individual rows — one compact batch row (AC7)", () => {
    ensureMonthlyStandardAllocation(learnerId, appId, tz, new Date("2026-08-15T09:00:00.000Z"));
    const rows = getDb().prepare("select * from learner_app_standard_credit_batches").all();
    expect(rows).toHaveLength(1);
  });

  it("shows a fresh eight-credit balance with the ordinary two-session weekly limit", () => {
    const allowance = buildStandardAllowance(learnerId, appId, tz, new Date("2026-08-03T09:00:00.000Z"));
    expect(allowance).toMatchObject({ availableCount: 8, expiringThisMonthCount: 0,
      standardSessionsUsedThisWeek: 0, standardWeeklyLimit: 2, catchUpEligible: false });
  });

  it("funds two ordinary sessions per week and denies a third without catch-up eligibility", () => {
    const monday = new Date("2026-08-03T09:00:00.000Z"); // 2026-W32
    const first = fund(monday);
    expect(first.weeklySessionOrdinal).toBe(1);
    consumeStandardReservation(first.batchId, learnerId, appId, first.weekKey, monday);
    const second = fund(new Date("2026-08-04T09:00:00.000Z"));
    expect(second.weeklySessionOrdinal).toBe(2);
    consumeStandardReservation(second.batchId, learnerId, appId, second.weekKey, new Date("2026-08-04T09:00:00.000Z"));
    expect(() => fund(new Date("2026-08-05T09:00:00.000Z")))
      .toThrowError(new StandardCreditError("WEEKLY_STANDARD_SESSION_LIMIT_REACHED"));
  });

  it("allows a catch-up third session only when balance >8 and a batch expires this month (AC12-18)", () => {
    // 2026-07-01 batch (expires end of Aug) plus the lazily-created 2026-08-01 batch (expires end of Sep):
    // 16 available total, 8 of which expire this month -> catch-up eligible for a third session.
    ensureMonthlyStandardAllocation(learnerId, appId, tz, new Date("2026-07-05T09:00:00.000Z"));
    const monday = new Date("2026-08-03T09:00:00.000Z");
    const first = fund(monday); consumeStandardReservation(first.batchId, learnerId, appId, first.weekKey, monday);
    const second = fund(new Date("2026-08-04T09:00:00.000Z"));
    consumeStandardReservation(second.batchId, learnerId, appId, second.weekKey, new Date("2026-08-04T09:00:00.000Z"));
    const allowance = buildStandardAllowance(learnerId, appId, tz, new Date("2026-08-05T09:00:00.000Z"));
    expect(allowance).toMatchObject({ availableCount: 14, expiringThisMonthCount: 6, catchUpEligible: true, standardWeeklyLimit: 3 });
    const third = fund(new Date("2026-08-05T09:00:00.000Z"));
    expect(third.weeklySessionOrdinal).toBe(3);
    // earliest-expiry-first: the third session must draw from the July batch (expiring this month), not August's.
    const julyBatch = getDb().prepare("select id from learner_app_standard_credit_batches where allocation_month='2026-07-01'").get() as { id: string };
    expect(third.batchId).toBe(julyBatch.id);
  });

  it("denies catch-up once the balance drops to exactly eight, and always denies a fourth session (AC15/AC19/AC20)", () => {
    const monday = new Date("2026-08-03T09:00:00.000Z");
    const first = fund(monday); consumeStandardReservation(first.batchId, learnerId, appId, first.weekKey, monday);
    const second = fund(new Date("2026-08-04T09:00:00.000Z"));
    consumeStandardReservation(second.batchId, learnerId, appId, second.weekKey, new Date("2026-08-04T09:00:00.000Z"));
    // balance is exactly 8 (no prior-month batch) -> catch-up must be denied even though 2 are already funded
    expect(() => fund(new Date("2026-08-05T09:00:00.000Z")))
      .toThrowError(new StandardCreditError("WEEKLY_STANDARD_SESSION_LIMIT_REACHED"));
    ensureMonthlyStandardAllocation(learnerId, appId, tz, new Date("2026-07-05T09:00:00.000Z"));
    const third = fund(new Date("2026-08-05T09:00:00.000Z"));
    consumeStandardReservation(third.batchId, learnerId, appId, third.weekKey, new Date("2026-08-05T09:00:00.000Z"));
    // a fourth is rejected outright, regardless of remaining balance
    expect(() => fund(new Date("2026-08-06T09:00:00.000Z")))
      .toThrowError(new StandardCreditError("WEEKLY_STANDARD_SESSION_LIMIT_REACHED"));
  });

  it("reserves at start (no consumed_count change) and only consumes+counts the week at usable launch (AC41/AC42/AC43/AC44)", () => {
    const now = new Date("2026-08-03T09:00:00.000Z");
    const funded = fund(now);
    expect(getDb().prepare("select reserved_count,consumed_count from learner_app_standard_credit_batches where id=?").get(funded.batchId))
      .toMatchObject({ reserved_count: 1, consumed_count: 0 });
    expect(getDb().prepare("select standard_sessions_funded n from learner_app_week_usage where learner_id=? and app_id=? and week_key=?")
      .get(learnerId, appId, funded.weekKey)).toMatchObject({ n: 0 });
    consumeStandardReservation(funded.batchId, learnerId, appId, funded.weekKey, now);
    expect(getDb().prepare("select reserved_count,consumed_count from learner_app_standard_credit_batches where id=?").get(funded.batchId))
      .toMatchObject({ reserved_count: 0, consumed_count: 1 });
    expect(getDb().prepare("select standard_sessions_funded n from learner_app_week_usage where learner_id=? and app_id=? and week_key=?")
      .get(learnerId, appId, funded.weekKey)).toMatchObject({ n: 1 });
  });

  it("releases an unexpired reservation back to available on pre-launch failure, but not an expired one (AC45/AC46)", () => {
    const now = new Date("2026-08-03T09:00:00.000Z");
    const funded = fund(now);
    expect(releaseStandardReservation(funded.batchId, new Date("2026-08-03T09:05:00.000Z"))).toBe(true);
    expect(getDb().prepare("select reserved_count,consumed_count,granted_count from learner_app_standard_credit_batches where id=?")
      .get(funded.batchId)).toMatchObject({ reserved_count: 0, consumed_count: 0, granted_count: 8 });
    const refunded = fund(new Date("2026-08-03T09:10:00.000Z"));
    expect(releaseStandardReservation(refunded.batchId, new Date("2026-09-30T18:30:00.001Z"))).toBe(false);
  });

  it("denies funding when no standard credit is available", () => {
    const db = getDb();
    const batch = ensureMonthlyStandardAllocation(learnerId, appId, tz, new Date("2026-08-03T09:00:00.000Z"));
    db.prepare("update learner_app_standard_credit_batches set consumed_count=8 where id=?").run(batch.id);
    expect(() => fund(new Date("2026-08-03T09:00:00.000Z")))
      .toThrowError(new StandardCreditError("STANDARD_SESSION_CREDIT_UNAVAILABLE"));
  });
});

// EN-001 business rules 15-24: the same compact-batch shape, keyed by an
// entitlement period instead of a calendar month. Reuses the existing
// reserve/consume/release trio unchanged — this only exercises that reuse,
// not liveBatches/fundStandardSession (deliberately not wired to
// entitlement-period batches; see the coexistence note in the service file).
function seedEntitlementPeriod(periodId: string) {
  const db = getDb();
  const cycleId = `cycle-for-${periodId}`;
  db.prepare(`insert or ignore into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,
    assigned_learner_id,product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,
    status,source_event_id,source_event_version,source_event_hash,created_at,ready_at,version)
    values(?,?,'sub-1',?,?,'product-1',1,'[]','2026-08-10T00:00:00.000Z','2026-09-10T00:00:00.000Z','2026-08-10',
    'ready','event-1',1,'hash','2026-08-10T00:00:00.000Z','2026-08-10T00:00:00.000Z',1)`)
    .run(cycleId, cycleId, parentId, learnerId);
  db.prepare(`insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,
    app_id,product_version,period_start,period_end,status,effective_source_role,created_at)
    values(?,?,'sub-1',?,?,1,'2026-08-10T00:00:00.000Z','2026-10-11T00:00:00.000Z','ready','allocation_bearing',
    '2026-08-10T00:00:00.000Z')`).run(periodId, cycleId, learnerId, appId);
}

describe("EN-001 entitlement-period-keyed standard credit batches", () => {
  it("allocates 8 credits keyed by entitlement_period_id, not allocation_month, and is idempotent", () => {
    const periodId = "period-1";
    seedEntitlementPeriod(periodId);
    const first = ensureEntitlementPeriodStandardAllocation(learnerId, appId, periodId,
      "2026-08-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z", new Date("2026-08-10T00:05:00.000Z"));
    expect(first).toMatchObject({ granted_count: 8, reserved_count: 0, consumed_count: 0,
      allocation_month: null, entitlement_period_id: periodId });
    const second = ensureEntitlementPeriodStandardAllocation(learnerId, appId, periodId,
      "2026-08-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z", new Date("2026-08-11T00:00:00.000Z"));
    expect(second).toEqual(first);
    expect(getDb().prepare("select count(*) n from learner_app_standard_credit_batches where entitlement_period_id=?")
      .get(periodId)).toMatchObject({ n: 1 });
  });

  it("reserve/consume/release work unchanged against a period-keyed batch id", () => {
    seedEntitlementPeriod("period-2");
    const batch = ensureEntitlementPeriodStandardAllocation(learnerId, appId, "period-2",
      "2026-08-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z", new Date("2026-08-10T00:05:00.000Z"));
    const db = getDb();
    db.prepare("update learner_app_standard_credit_batches set reserved_count=1 where id=?").run(batch.id);
    consumeStandardReservation(batch.id, learnerId, appId, "2026-W33", new Date("2026-08-10T00:10:00.000Z"));
    expect(db.prepare("select reserved_count,consumed_count from learner_app_standard_credit_batches where id=?")
      .get(batch.id)).toMatchObject({ reserved_count: 0, consumed_count: 1 });
    db.prepare("update learner_app_standard_credit_batches set reserved_count=1 where id=?").run(batch.id);
    expect(releaseStandardReservation(batch.id, new Date("2026-08-10T00:15:00.000Z"))).toBe(true);
    expect(db.prepare("select reserved_count from learner_app_standard_credit_batches where id=?")
      .get(batch.id)).toMatchObject({ reserved_count: 0 });
  });
});
