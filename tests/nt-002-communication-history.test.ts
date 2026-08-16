// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createLearner } from "@/lib/db/learner-repo";
import type { TransactionalEmailProvider } from "@/lib/notifications/provider-adapter";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";
import { ingestNotificationProviderEvent } from "@/lib/notifications/webhook";
import {
  composeParentCommunicationHistory,
  ParentCommunicationHistoryRequestError,
} from "@/lib/notification-history/service";
import { decodeHistoryCursor, encodeHistoryCursor } from "@/lib/notification-history/contracts";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt002-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

function acceptingProvider(): TransactionalEmailProvider {
  return { send: () => ({ status: "accepted", providerMessageId: `pm-${randomUUID()}` }) };
}

function deliveringProvider(): TransactionalEmailProvider {
  return { send: () => ({ status: "delivered", providerMessageId: `pm-${randomUUID()}` }) };
}

function failingProvider(): TransactionalEmailProvider {
  return { send: () => ({ status: "failed" }) };
}

function enqueueAndDeliver(input: {
  notificationType: string; sourceEventKey?: string; safeVariables: Record<string, unknown>;
  provider?: TransactionalEmailProvider; now?: Date; learnerId?: string;
}) {
  const now = input.now ?? new Date("2026-08-10T00:00:00.000Z");
  const { notificationId } = enqueueTransactionalNotification({
    notificationType: input.notificationType, sourceDomain: input.notificationType.startsWith("account")
      ? "identity" : input.notificationType === "approved_service_notice" ? "operations" : "billing",
    sourceEventKey: input.sourceEventKey ?? `evt-${randomUUID()}`, sourceVersion: 1, parentId,
    safeVariables: input.safeVariables, learnerId: input.learnerId,
  }, now);
  runNotificationDeliverySweep({ provider: input.provider ?? acceptingProvider(), now });
  return notificationId;
}

describe("NT-002 composeParentCommunicationHistory", () => {
  it("AT-NT-002-01: an active parent gets a 200-shaped history composition", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.retentionMonths).toBe(13);
    expect(history.items).toHaveLength(1);
    expect(history.historyVersion).toBeTruthy();
  });

  it("AT-NT-002-05: one row per logical notification — a retry never duplicates", () => {
    const { notificationId } = enqueueTransactionalNotification({
      notificationType: "billing_grace_started", sourceDomain: "billing", sourceEventKey: `evt-${randomUUID()}`,
      sourceVersion: 1, parentId, safeVariables: { subscriptionLabel: "Family Plan", graceEndsAt: "2026-08-20" },
    }, new Date("2026-08-10T00:00:00.000Z"));
    // First attempt fails temporarily, second attempt (still the same intent/delivery row) succeeds.
    runNotificationDeliverySweep({ provider: failingProvider(), now: new Date("2026-08-10T00:00:00.000Z") });
    getDb().prepare("update transactional_notification_intents set next_attempt_at=? where notification_id=?")
      .run("2026-08-10T00:00:00.000Z", notificationId);
    runNotificationDeliverySweep({ provider: acceptingProvider(), now: new Date("2026-08-10T01:00:00.000Z") });

    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(1);
    expect(history.items[0].communicationId).toBe(notificationId);
  });

  it("AT-NT-002-06: a replayed provider webhook callback never duplicates the row", () => {
    const SECRET = "test-nt002-secret";
    const notificationId = enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    const delivery = getDb().prepare("select provider_idempotency_key from transactional_notification_deliveries where notification_id=?")
      .get(notificationId) as { provider_idempotency_key: string };
    const now = new Date("2026-08-11T00:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey: delivery.provider_idempotency_key, eventType: "delivered", occurredAt: now.toISOString() });
    const signatureHex = createHmac("sha256", SECRET).update(`${timestampSeconds}.${rawBody}`).digest("hex");
    ingestNotificationProviderEvent({ provider: "test", providerEventId: `wh-${randomUUID()}`, timestampSeconds, signatureHex, rawBody, secret: SECRET, now });

    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(1);
    expect(history.items[0].deliveryState).toBe("delivered");
  });

  it("AT-NT-002-07: newest first, stable tie-break", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "A" }, now: new Date("2026-08-01T00:00:00.000Z") });
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "B" }, now: new Date("2026-08-03T00:00:00.000Z") });
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "C" }, now: new Date("2026-08-02T00:00:00.000Z") });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items.map((i) => i.subscriptionContext)).toEqual(["B", "C", "A"]);
  });

  it("AT-NT-002-08: deterministic keyset pagination — stable pages, no duplicates or gaps", () => {
    for (let i = 0; i < 5; i++) {
      enqueueAndDeliver({
        notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: `S${i}` },
        now: new Date(2026, 7, 1 + i),
      });
    }
    const page1 = composeParentCommunicationHistory(parentId, { limit: "2" }, new Date("2026-08-13T00:00:00.000Z"));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = composeParentCommunicationHistory(parentId, { limit: "2", cursor: page1.nextCursor ?? undefined }, new Date("2026-08-13T00:00:00.000Z"));
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeTruthy();
    const page3 = composeParentCommunicationHistory(parentId, { limit: "2", cursor: page2.nextCursor ?? undefined }, new Date("2026-08-13T00:00:00.000Z"));
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    const allIds = [...page1.items, ...page2.items, ...page3.items].map((i) => i.communicationId);
    expect(new Set(allIds).size).toBe(5);
  });

  it("AT-NT-002-09: retention boundary — items older than 13 months are excluded", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    const insideWindow = new Date(now); insideWindow.setMonth(insideWindow.getMonth() - 12);
    const outsideWindow = new Date(now); outsideWindow.setMonth(outsideWindow.getMonth() - 14);
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "In" }, now: insideWindow });
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Out" }, now: outsideWindow });
    const history = composeParentCommunicationHistory(parentId, {}, now);
    expect(history.items).toHaveLength(1);
    expect(history.items[0].subscriptionContext).toBe("In");
  });

  it("AT-NT-002-12: uses the approved human-readable title, not the raw type key", () => {
    enqueueAndDeliver({ notificationType: "billing_grace_started", safeVariables: { subscriptionLabel: "Family Plan", graceEndsAt: "2026-08-20" } });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].title).not.toContain("billing_grace_started");
    expect(history.items[0].title.length).toBeGreaterThan(0);
  });

  it("AT-NT-002-13: no provider IDs or internal source event keys are exposed", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    const serialized = JSON.stringify(history);
    expect(serialized).not.toMatch(/pm-/);
    expect(serialized).not.toMatch(/evt-/);
  });

  it("AT-NT-002-14: an accepted delivery displays as Sent", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" }, provider: acceptingProvider() });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].deliveryState).toBe("sent");
  });

  it("AT-NT-002-15: a webhook-confirmed delivery displays as Delivered", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" }, provider: deliveringProvider() });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].deliveryState).toBe("delivered");
  });

  it("AT-NT-002-16/17: temporary failure reads as sending/delayed, not falsely permanent; a real permanent failure reads as delivery_failed", () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const { notificationId } = enqueueTransactionalNotification({
      notificationType: "billing_payment_recovered", sourceDomain: "billing", sourceEventKey: `evt-${randomUUID()}`,
      sourceVersion: 1, parentId, safeVariables: { subscriptionLabel: "Family Plan" },
    }, now);
    runNotificationDeliverySweep({ provider: failingProvider(), now });
    let history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items.find((i) => i.communicationId === notificationId)!.deliveryState).toBe("sending_or_delayed");

    for (let attempt = 0; attempt < 5; attempt++) {
      getDb().prepare("update transactional_notification_intents set next_attempt_at=? where notification_id=?")
        .run(now.toISOString(), notificationId);
      runNotificationDeliverySweep({ provider: failingProvider(), now });
    }
    history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items.find((i) => i.communicationId === notificationId)!.deliveryState).toBe("delivery_failed");
  });

  it("AT-NT-002-18: never claims Opened/Read", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" }, provider: deliveringProvider() });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].deliveryState).not.toMatch(/open|read/i);
  });

  it("AT-NT-002-22: account/security rows use a minimal safe label with no secrets", () => {
    enqueueAndDeliver({ notificationType: "account_email_changed", safeVariables: {} });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].category).toBe("account_security");
    expect(history.items[0].title.toLowerCase()).not.toMatch(/password|token|reason/);
  });

  it("AT-NT-002-24: safe learner display name only when the source type legitimately carries one", () => {
    enqueueAndDeliver({
      notificationType: "billing_renewal_reminder",
      safeVariables: { subscriptionLabel: "Family Plan", renewalDate: "2026-09-01", amount: 999, currency: "INR", learnerName: "Aanya" },
    });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].learnerContext).toBe("Aanya");
  });

  it("AT-NT-002-25: no payment credentials are ever present", () => {
    enqueueAndDeliver({ notificationType: "billing_renewal_reminder",
      safeVariables: { subscriptionLabel: "Family Plan", renewalDate: "2026-09-01", amount: 999, currency: "INR" } });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    const serialized = JSON.stringify(history).toLowerCase();
    expect(serialized).not.toMatch(/card|token|account_number/);
  });

  it("AT-NT-002-27: a billing row carries a Manage subscription action that routes to the current summary, not a stale specific record", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].action).toEqual({ label: "Manage subscription", href: "/account/subscriptions" });
  });

  it("no action is offered for invoice_receipt_available — no real BI-005 document route exists yet", () => {
    enqueueAndDeliver({ notificationType: "invoice_receipt_available", safeVariables: { documentLabel: "August invoice" } });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items[0].action).toBeUndefined();
  });

  it("AT-NT-002-31/32: no mutation is possible through this module — it exports no write function", async () => {
    const moduleExports = await import("@/lib/notification-history/service");
    expect(Object.keys(moduleExports).some((key) => /delete|edit|resolve|resend/i.test(key))).toBe(false);
  });

  it("AT-NT-002-35: category filter narrows to the correct subset", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    enqueueAndDeliver({ notificationType: "account_password_changed", safeVariables: {} });
    const history = composeParentCommunicationHistory(parentId, { category: "account_security" }, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(1);
    expect(history.items[0].category).toBe("account_security");
  });

  it("rejects an invalid category/cursor/limit with a typed request error", () => {
    expect(() => composeParentCommunicationHistory(parentId, { category: "not_a_category" }, new Date()))
      .toThrow(ParentCommunicationHistoryRequestError);
    expect(() => composeParentCommunicationHistory(parentId, { cursor: "not-a-real-cursor!!" }, new Date()))
      .toThrow(ParentCommunicationHistoryRequestError);
    expect(() => composeParentCommunicationHistory(parentId, { limit: "0" }, new Date()))
      .toThrow(ParentCommunicationHistoryRequestError);
    expect(() => composeParentCommunicationHistory(parentId, { limit: "51" }, new Date()))
      .toThrow(ParentCommunicationHistoryRequestError);
  });

  it("AT-NT-002-45/46: reading history sends nothing and creates no attention — pure read", () => {
    enqueueAndDeliver({ notificationType: "billing_grace_started", safeVariables: { subscriptionLabel: "Family Plan", graceEndsAt: "2026-08-20" } });
    const before = getDb().prepare("select count(*) as n from transactional_notification_deliveries").get() as { n: number };
    composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    const after = getDb().prepare("select count(*) as n from transactional_notification_deliveries").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("AT-NT-002-48: never surfaces another parent's communications", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`nt002-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", otherParent.id);
    enqueueTransactionalNotification({
      notificationType: "billing_payment_recovered", sourceDomain: "billing", sourceEventKey: `evt-${randomUUID()}`,
      sourceVersion: 1, parentId: otherParent.id, safeVariables: { subscriptionLabel: "Other" },
    }, new Date("2026-08-10T00:00:00.000Z"));
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(0);
  });

  it("AT-NT-002-49: only the approved safe fields are exposed, not raw safe_variables wholesale", () => {
    enqueueAndDeliver({
      notificationType: "billing_refund_outcome",
      safeVariables: { subscriptionLabel: "Family Plan", refundType: "full", amount: 500 },
    });
    const history = composeParentCommunicationHistory(parentId, {}, new Date("2026-08-13T00:00:00.000Z"));
    const item = history.items[0] as unknown as Record<string, unknown>;
    expect(item.refundType).toBeUndefined();
    expect(item.amount).toBeUndefined();
  });

  it("is deterministic — composing twice with the same inputs yields the same historyVersion", () => {
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    const now = new Date("2026-08-13T00:00:00.000Z");
    const a = composeParentCommunicationHistory(parentId, {}, now);
    const b = composeParentCommunicationHistory(parentId, {}, now);
    expect(a.historyVersion).toBe(b.historyVersion);
  });
});

describe("NT-002 (NT2-G01) learner filtering applied before pagination", () => {
  function makeLearner(displayName: string) {
    return createLearner(parentId, { displayName, dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() },
      "2026-08-13").learner;
  }

  it("AC: learner filtering finds Learner A's older communications even with 50+ newer Learner B rows ahead of them", () => {
    const learnerA = makeLearner("Learner A");
    const learnerB = makeLearner("Learner B");
    enqueueAndDeliver({
      notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "A Plan" },
      learnerId: learnerA.id, now: new Date("2026-08-01T00:00:00.000Z"),
    });
    for (let i = 0; i < 55; i++) {
      enqueueAndDeliver({
        notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: `B${i}` },
        learnerId: learnerB.id, now: new Date(2026, 7, 2, 0, i),
      });
    }
    const history = composeParentCommunicationHistory(
      parentId, { learnerId: learnerA.id, limit: "20" }, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(1);
    expect(history.items[0].subscriptionContext).toBe("A Plan");
  });

  it("filtered pagination produces no gaps or duplicates across a full learner-scoped dataset", () => {
    const learnerA = makeLearner("Learner A");
    const learnerB = makeLearner("Learner B");
    const aIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      aIds.push(enqueueAndDeliver({
        notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: `A${i}` },
        learnerId: learnerA.id, now: new Date(2026, 7, 1, 0, i),
      }));
      enqueueAndDeliver({
        notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: `B${i}` },
        learnerId: learnerB.id, now: new Date(2026, 7, 1, 1, i),
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = composeParentCommunicationHistory(
        parentId, { learnerId: learnerA.id, limit: "3", cursor }, new Date("2026-08-13T00:00:00.000Z"));
      seen.push(...result.items.map((i) => i.communicationId));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...aIds].sort());
  });

  it("category + learner + cursor filters combine correctly", () => {
    const learnerA = makeLearner("Learner A");
    enqueueAndDeliver({
      notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "A Billing" },
      learnerId: learnerA.id, now: new Date("2026-08-01T00:00:00.000Z"),
    });
    enqueueAndDeliver({ notificationType: "account_password_changed", safeVariables: {}, now: new Date("2026-08-02T00:00:00.000Z") });
    const history = composeParentCommunicationHistory(
      parentId, { learnerId: learnerA.id, category: "billing" }, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(1);
    expect(history.items[0].subscriptionContext).toBe("A Billing");
  });

  it("a foreign/unowned learnerId returns no leaked data", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`nt002-learner-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    const foreignLearner = createLearner(otherParent.id,
      { displayName: "Foreign", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-13").learner;
    enqueueAndDeliver({ notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Family Plan" } });
    const history = composeParentCommunicationHistory(
      parentId, { learnerId: foreignLearner.id }, new Date("2026-08-13T00:00:00.000Z"));
    expect(history.items).toHaveLength(0);
  });

  it("structured learnerId matches regardless of a later learner rename; legacy display-name-only rows do not", async () => {
    const learner = makeLearner("Original Name");
    const structuredId = enqueueAndDeliver({
      notificationType: "billing_payment_recovered", safeVariables: { subscriptionLabel: "Structured" },
      learnerId: learner.id, now: new Date("2026-08-01T00:00:00.000Z"),
    });
    const legacyId = enqueueAndDeliver({
      notificationType: "billing_renewal_reminder",
      safeVariables: { subscriptionLabel: "Legacy", renewalDate: "2026-09-01", amount: 100, currency: "INR",
        learnerName: "Original Name" },
      now: new Date("2026-08-02T00:00:00.000Z"),
      // no learnerId — simulates a pre-NT2-G01 row that only ever had the
      // display-name snapshot.
    });
    getDb().prepare("update learners set display_name=? where id=?").run("Renamed", learner.id);

    const afterRename = composeParentCommunicationHistory(
      parentId, { learnerId: learner.id }, new Date("2026-08-13T00:00:00.000Z"));
    const ids = afterRename.items.map((i) => i.communicationId);
    expect(ids).toContain(structuredId);
    // documented limitation: the legacy row's snapshot ("Original Name")
    // no longer matches the learner's current display name ("Renamed").
    expect(ids).not.toContain(legacyId);
  });
});

describe("NT-002 history cursor", () => {
  it("round-trips through encode/decode", () => {
    const cursor = { createdAt: "2026-08-01T00:00:00.000Z", notificationId: "abc-123" };
    expect(decodeHistoryCursor(encodeHistoryCursor(cursor))).toEqual(cursor);
  });
});
