import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { BillingAssignmentError } from "@/lib/billing/errors";
import {
  localCheckoutProviderAdapter,
  resolveBillingProviderAdapter,
  signLocalWebhookPayload,
} from "@/lib/billing/provider-adapter";

const ACCOUNT = "babysteps-local-test";
const baseEvent = {
  providerEventId: "evt-bi003-1",
  eventType: "initial_payment_failed",
  providerPaymentRef: "pay-bi003-1",
  amount: 29900,
  currency: "INR",
  priceId: "price-bi003-1",
  priceVersion: 1,
  settledAt: "2026-08-24T10:00:00.000Z",
};

function verify(value: unknown, signatureBody?: string) {
  const rawBody = JSON.stringify(value);
  return localCheckoutProviderAdapter.verifyWebhook!({
    rawBody,
    signature: signLocalWebhookPayload(signatureBody ?? rawBody),
    environment: "test",
    accountId: ACCOUNT,
  });
}

beforeEach(() => useInMemoryDb());

describe("BI-003 payment provider security boundary certification", () => {
  it("rejects invalid signatures and payload modification before recording evidence", () => {
    const rawBody = JSON.stringify(baseEvent);
    expect(() => localCheckoutProviderAdapter.verifyWebhook!({
      rawBody,
      signature: "00",
      environment: "test",
      accountId: ACCOUNT,
    })).toThrow(new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED"));
    expect(() => verify({ ...baseEvent, amount: 1 }, rawBody))
      .toThrow(new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED"));
    expect((getDb().prepare("select count(*) n from payment_provider_events").get() as { n: number }).n).toBe(0);
    expect((getDb().prepare("select count(*) n from billing_periods").get() as { n: number }).n).toBe(0);
  });

  it("fails closed for wrong account, environment, provider, malformed fields, and extensions", () => {
    const rawBody = JSON.stringify(baseEvent);
    const signature = signLocalWebhookPayload(rawBody);
    for (const input of [
      { environment: "production", accountId: ACCOUNT },
      { environment: "test", accountId: "wrong-account" },
      { environment: "preview", accountId: ACCOUNT },
    ]) {
      expect(() => localCheckoutProviderAdapter.verifyWebhook!({ rawBody, signature, ...input }))
        .toThrow(new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED"));
    }
    expect(() => resolveBillingProviderAdapter("unknown-provider"))
      .toThrow(new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED"));
    for (const event of [
      { ...baseEvent, currency: "inr" },
      { ...baseEvent, priceVersion: 0 },
      { ...baseEvent, amount: 1.5 },
      { ...baseEvent, injectedAdminOverride: true },
      { ...baseEvent, eventType: "payment_succeeded_without_contract" },
    ]) expect(() => verify(event)).toThrow(new BillingAssignmentError("INVALID_REQUEST"));
  });

  it("accepts a valid exact raw body and returns only authenticated context", () => {
    expect(verify(baseEvent)).toMatchObject({
      ...baseEvent,
      provider: "local-provider",
      environment: "test",
      accountId: ACCOUNT,
    });
  });

  it("makes accepted provider identity and payload evidence append-only", () => {
    const db = getDb();
    db.prepare(`insert into payment_provider_events(provider,environment,account_id,provider_event_id,
      event_type,payload_hash,status,received_at) values(?,?,?,?,?,?,?,?)`).run(
      "local-provider", "test", ACCOUNT, "evt-immutable", "initial_payment_failed",
      "original-hash", "received", "2026-08-24T10:00:00.000Z",
    );
    expect(() => db.prepare("update payment_provider_events set payload_hash='tampered' where provider_event_id=?")
      .run("evt-immutable")).toThrow(/provider event context is immutable/);
    expect(() => db.prepare("delete from payment_provider_events where provider_event_id=?")
      .run("evt-immutable")).toThrow(/provider events are append-only/);
    expect(() => db.prepare(`update payment_provider_events set status='rejected',error_code='INVALID_REQUEST',
      processed_at='2026-08-24T10:01:00.000Z' where provider_event_id=?`).run("evt-immutable")).not.toThrow();
  });
});
