// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { resolveCustomer } from "@/lib/support-cases/service";
import { SupportCaseError } from "@/lib/support-cases/contracts";

let parentId: string;
let parentEmail: string;
let staff: ReturnType<typeof seedStaffSession>;

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  getDb().prepare("update profiles set display_name=? where id=?").run("Test Parent", parentId);
  staff = seedStaffSession(["support_agent"]);
});

const REASON = "Investigating a billing question raised by the parent via phone.";

describe("AD-002 resolveCustomer (AT-AD-002-02/03/04/07/08)", () => {
  it("AT-02: exact verified email match returns exactly one minimal result", async () => {
    const result = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
    expect(result.matched).toBe(true);
    expect(result.displayName).toBe("Test Parent");
    expect(result.maskedEmail).not.toBe(parentEmail);
    expect(result.receiptId).toBeTruthy();
  });

  it("an unverified email never matches", async () => {
    const { user } = await sqliteAuthAdapter.signUp(`unverified-${randomUUID()}@example.com`, "CorrectHorse1!");
    const result = await resolveCustomer(staff, { identifierType: "email", identifierValue: user.email, reason: REASON });
    expect(result.matched).toBe(false);
  });

  it("AT-03: a partial/substring email is never matched (no fuzzy)", async () => {
    const partial = parentEmail.slice(0, parentEmail.indexOf("@"));
    const result = await resolveCustomer(staff, { identifierType: "email", identifierValue: partial, reason: REASON });
    expect(result.matched).toBe(false);
  });

  it("AT-07: a reason shorter than 20 characters is rejected", async () => {
    await expect(resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: "too short" }))
      .rejects.toThrow(SupportCaseError);
  });

  it("a reason longer than 500 characters is rejected", async () => {
    await expect(resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: "x".repeat(501) }))
      .rejects.toThrow(SupportCaseError);
  });

  it("AT-05: an exact subscription reference resolves only its owning parent", async () => {
    const subscriptionId = randomUUID();
    seedMinimalSubscription(subscriptionId, parentId, await seedLearner(parentId));
    const result = await resolveCustomer(staff, { identifierType: "subscription_ref", identifierValue: subscriptionId, reason: REASON });
    expect(result.matched).toBe(true);
  });

  it("an unknown subscription reference does not match", async () => {
    const result = await resolveCustomer(staff, { identifierType: "subscription_ref", identifierValue: randomUUID(), reason: REASON });
    expect(result.matched).toBe(false);
  });

  it("AT-06: an exact invoice/payment reference resolves only its owning parent", async () => {
    const learnerId = await seedLearner(parentId);
    const subscriptionId = randomUUID();
    seedMinimalSubscription(subscriptionId, parentId, learnerId);
    const paymentId = randomUUID();
    getDb().prepare(
      "insert into payments(id,subscription_id,amount_inr,razorpay_payment_id,paid_at) values(?,?,?,?,?)",
    ).run(paymentId, subscriptionId, 29900, `rzp_${randomUUID()}`, new Date().toISOString());
    const result = await resolveCustomer(staff, { identifierType: "invoice_ref", identifierValue: paymentId, reason: REASON });
    expect(result.matched).toBe(true);
  });

  it("stores only a hash of the identifier, never the plaintext, in the receipt", async () => {
    const result = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
    const row = getDb().prepare("select identifier_hash from support_lookup_receipts where id=?").get(result.receiptId) as
      { identifier_hash: string };
    expect(row.identifier_hash).not.toBe(parentEmail);
    expect(row.identifier_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function seedLearner(ownerParentId: string): Promise<string> {
  return (await createLearner(ownerParentId, { displayName: "Test Learner", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
}

function seedMinimalSubscription(subscriptionId: string, purchaserParentId: string, learnerId: string) {
  const db = getDb();
  // The product catalog is synced on every boot (src/lib/db/client.ts) —
  // reuse a real seeded product rather than hand-crafting one, avoiding
  // this fixture drifting out of sync with the products table's full
  // not-null column set.
  const { id: productId } = db.prepare("select id from products limit 1").get() as { id: string };
  db.prepare(
    `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,status,
     razorpay_subscription_id,current_period_end) values(?,?,'single',?,?,?,'active',?,?)`,
  ).run(subscriptionId, purchaserParentId, productId, purchaserParentId, learnerId, `rzp_sub_${randomUUID()}`,
    new Date(Date.now() + 30 * 86_400_000).toISOString());
}
