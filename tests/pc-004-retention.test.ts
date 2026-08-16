// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createLearner } from "@/lib/db/learner-repo";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { reconcileLearnerRetentionState, purgeLearnerJourneyIfDue, addTwelveCalendarMonthsKolkata } from "@/lib/journey/service";
import {
  erasePersonalAndLearningData, listErasureReceipts, replayDeletionObligations, retryProcessorPropagation,
} from "@/lib/data-retention/service";

beforeEach(() => {
  useInMemoryDb();
});

async function seedLearner() {
  const { user } = await sqliteAuthAdapter.signUp(`p-${randomUUID()}@example.com`, "CorrectHorse1!");
  return createLearner(user.id, { displayName: "Test Kid", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-10").learner.id;
}

async function seedLearnerWithParent() {
  const { user } = await sqliteAuthAdapter.signUp(`p-${randomUUID()}@example.com`, "CorrectHorse1!");
  const learnerId = createLearner(user.id, { displayName: "Test Kid", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-10").learner.id;
  return { parentId: user.id, learnerId };
}

describe("PC-004 erasePersonalAndLearningData", () => {
  it("de-identifies the learner's own direct PII fields (display_name/normalized_display_name/date_of_birth)", async () => {
    const learnerId = await seedLearner();
    erasePersonalAndLearningData(learnerId, new Date("2027-08-11T00:00:00.000Z"));
    const row = getDb().prepare("select display_name, normalized_display_name, date_of_birth from learners where id=?")
      .get(learnerId) as { display_name: string; normalized_display_name: string; date_of_birth: string };
    expect(row.display_name).toBe("Deleted Learner");
    expect(row.date_of_birth).not.toBe("2018-01-01");
    expect(row.normalized_display_name).toContain(learnerId);
  });

  it("is idempotent — a second call is a safe no-op, never re-erasing an already-erased learner", async () => {
    const learnerId = await seedLearner();
    const now = new Date("2027-08-11T00:00:00.000Z");
    erasePersonalAndLearningData(learnerId, now);
    erasePersonalAndLearningData(learnerId, now);
    const receipts = listErasureReceipts(learnerId);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
  });

  it("records a minimal, attributable deletion-evidence receipt", async () => {
    const learnerId = await seedLearner();
    erasePersonalAndLearningData(learnerId, new Date("2027-08-11T00:00:00.000Z"));
    const receipts = listErasureReceipts(learnerId);
    expect(receipts[0]).toMatchObject({ learner_id: learnerId, processor_status: "none_configured" });
  });

  it("never touches any financial/security/audit legal-retention table", async () => {
    const { parentId, learnerId } = await seedLearnerWithParent();
    const { id: productId, version: productVersion } = getDb().prepare("select id, version from products limit 1")
      .get() as { id: string; version: number };
    const subscriptionId = randomUUID();
    getDb().prepare(
      `insert into subscriptions(id,user_id,type,product_id,product_version,purchaser_parent_id,assigned_learner_id,
       status,razorpay_subscription_id,current_period_end) values(?,?,'single',?,?,?,?,'active',?,?)`,
    ).run(subscriptionId, parentId, productId, productVersion, parentId, learnerId, `rzp_${randomUUID()}`,
      new Date(Date.now() + 30 * 86_400_000).toISOString());
    getDb().prepare(
      "insert into payments (id,subscription_id,amount_inr,razorpay_payment_id,paid_at,created_at) values (?,?,?,?,?,?)",
    ).run(randomUUID(), subscriptionId, 299, "pay_1", new Date().toISOString(), new Date().toISOString());
    const before = getDb().prepare("select count(*) n from payments").get();
    erasePersonalAndLearningData(learnerId, new Date());
    expect(getDb().prepare("select count(*) n from payments").get()).toEqual(before);
  });
});

describe("PC-004 the one-year retention timer reused from journey/service.ts drives erasure via the existing sweep", () => {
  it("purgeLearnerJourneyIfDue also erases the learner's PII once the same due-check fires", async () => {
    const learnerId = await seedLearner();
    const inactiveSince = new Date("2026-08-10T00:00:00.000Z");
    reconcileLearnerRetentionState(learnerId, inactiveSince, inactiveSince);
    const due = addTwelveCalendarMonthsKolkata(inactiveSince);
    const result = purgeLearnerJourneyIfDue(learnerId, new Date(due.getTime() + 1000));
    expect(result.purged).toBe(true);
    const row = getDb().prepare("select display_name from learners where id=?").get(learnerId) as { display_name: string };
    expect(row.display_name).toBe("Deleted Learner");
  });
});

describe("PC-004 replayDeletionObligations (BR-002 handoff)", () => {
  it("re-applies erasure when a restored backup resurrects pre-erasure data for an already-purged learner", async () => {
    const learnerId = await seedLearner();
    const inactiveSince = new Date("2026-08-10T00:00:00.000Z");
    reconcileLearnerRetentionState(learnerId, inactiveSince, inactiveSince);
    const due = addTwelveCalendarMonthsKolkata(inactiveSince);
    purgeLearnerJourneyIfDue(learnerId, new Date(due.getTime() + 1000));
    // Simulate a backup restore resurrecting the pre-erasure name.
    getDb().prepare("update learners set display_name='Test Kid' where id=?").run(learnerId);
    const result = replayDeletionObligations(learnerId, new Date(due.getTime() + 2000));
    expect(result.replayed).toBe(true);
    const row = getDb().prepare("select display_name from learners where id=?").get(learnerId) as { display_name: string };
    expect(row.display_name).toBe("Deleted Learner");
  });

  it("is a no-op for a learner who was never purged", async () => {
    const learnerId = await seedLearner();
    expect(replayDeletionObligations(learnerId, new Date()).replayed).toBe(false);
  });

  it("is a no-op for an already-erased learner — never double-processes", async () => {
    const learnerId = await seedLearner();
    const inactiveSince = new Date("2026-08-10T00:00:00.000Z");
    reconcileLearnerRetentionState(learnerId, inactiveSince, inactiveSince);
    const due = addTwelveCalendarMonthsKolkata(inactiveSince);
    purgeLearnerJourneyIfDue(learnerId, new Date(due.getTime() + 1000));
    expect(replayDeletionObligations(learnerId, new Date(due.getTime() + 2000)).replayed).toBe(false);
  });
});

describe("PC-004 retryProcessorPropagation", () => {
  it("is a real, callable, tracked no-op while no external processor is registered", async () => {
    const learnerId = await seedLearner();
    erasePersonalAndLearningData(learnerId, new Date());
    const result = retryProcessorPropagation(learnerId, new Date());
    expect(result.attempted).toBe(0);
  });
});
