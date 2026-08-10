import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { BillingAssignmentError } from "@/lib/billing/errors";

export type BillingEnvironment = "test" | "production";
export type BillingInterval = "month" | "year";

export type ProviderCheckoutInput = {
  checkoutIntentId: string;
  purchaserParentId: string;
  assignedLearnerId: string;
  productId: string;
  productVersion: number;
  priceId?: string;
  priceVersion?: number;
  amount?: number;
  currency?: string;
  billingInterval?: BillingInterval;
  intervalCount?: number;
  autoRenewEnabled?: boolean;
};

export type ProviderCheckoutHandoff = {
  provider: string;
  environment?: BillingEnvironment;
  accountId?: string;
  providerCheckoutRef: string;
  providerSubscriptionRef?: string;
  providerMandateRef?: string;
  handoff: { url: string; method: "GET" | "POST" };
};

export type VerifiedProviderPaymentEvent = {
  provider: string;
  environment: BillingEnvironment;
  accountId: string;
  providerEventId: string;
  eventType:
    | "initial_payment_succeeded"
    | "initial_payment_failed"
    | "renewal_payment_succeeded"
    | "renewal_payment_failed"
    | "renewal_failed"
    | "retry_failed"
    | "payment_recovered"
    | "delayed_settlement";
  checkoutIntentId?: string;
  subscriptionId?: string;
  providerCheckoutRef?: string;
  providerPaymentRef: string;
  providerInvoiceRef?: string;
  providerAttemptRef?: string;
  providerSubscriptionRef?: string;
  providerCustomerRef?: string;
  providerPaymentMethodRef?: string;
  providerMandateRef?: string;
  amount: number;
  currency: string;
  priceId: string;
  priceVersion: number;
  settledAt: string;
  attemptedAt?: string;
  failureCode?: string;
};

export type VerifiedProviderRecurringAgreementEvent = {
  provider: string;
  environment: BillingEnvironment;
  accountId: string;
  providerEventId: string;
  eventType: "recurring_agreement_confirmed" | "recurring_agreement_failed";
  subscriptionId: string;
  providerSubscriptionRef: string;
  providerMandateRef?: string;
  providerSetupSessionRef?: string;
  occurredAt: string;
  failureCode?: string;
};

export type VerifiedProviderBillingEvent = VerifiedProviderPaymentEvent | VerifiedProviderRecurringAgreementEvent;

export interface BillingCheckoutProviderAdapter {
  createCheckout(input: ProviderCheckoutInput): ProviderCheckoutHandoff;
  verifyWebhook?(input: {
    rawBody: string;
    signature: string;
    environment: string;
    accountId: string;
  }): VerifiedProviderBillingEvent;
  disableAutoRenewal?(input: {
    providerSubscriptionRef: string;
    providerMandateRef: string | null;
    cancelAtPeriodEnd: true;
    idempotencyKey?: string;
  }): { confirmed: true };
  getRecurringAgreementStatus?(input: {
    providerSubscriptionRef: string;
    providerMandateRef: string | null;
  }): { status: "valid" | "invalid" };
  enableAutoRenewal?(input: {
    providerSubscriptionRef: string;
    providerMandateRef: string;
    idempotencyKey: string;
  }): { confirmed: true };
  createRecurringAgreementSetupSession?(input: {
    purchaserParentId: string;
    subscriptionId: string;
    providerCustomerRef: string | null;
    providerSubscriptionRef: string;
    expiresAt: string;
    idempotencyKey: string;
  }): { providerSessionRef: string; handoffUrl: string; expiresAt: string };
  createPaymentMethodUpdateSession?(input: {
    purchaserParentId: string;
    subscriptionId: string;
    providerCustomerRef: string | null;
    providerSubscriptionRef: string;
    expiresAt: string;
    idempotencyKey: string;
  }): { providerSessionRef: string; handoffUrl: string; expiresAt: string };
  stopRenewalRetries?(input: {
    providerSubscriptionRef: string;
    providerMandateRef: string | null;
  }): { confirmed: true };
  listReconciliationEvents?(input: {
    environment: BillingEnvironment;
    startDate: string;
    endDate: string;
    cursor?: string;
    limit: number;
  }): { events: VerifiedProviderBillingEvent[]; nextCursor: string | null };
}

const LOCAL_PROVIDER = "local-provider";
const LOCAL_TEST_ACCOUNT = "babysteps-local-test";
const LOCAL_TEST_SECRET = "babysteps-local-webhook-test-secret";

function localWebhookSecret(environment: string) {
  if (environment === "test") return process.env.BILLING_LOCAL_TEST_WEBHOOK_SECRET ?? LOCAL_TEST_SECRET;
  const secret = process.env.BILLING_LOCAL_PRODUCTION_WEBHOOK_SECRET;
  if (!secret) throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
  return secret;
}

function expectedLocalAccount(environment: string) {
  return environment === "test"
    ? process.env.BILLING_LOCAL_TEST_ACCOUNT_ID ?? LOCAL_TEST_ACCOUNT
    : process.env.BILLING_LOCAL_PRODUCTION_ACCOUNT_ID ?? "";
}

export function signLocalWebhookPayload(rawBody: string, environment: BillingEnvironment = "test") {
  return createHmac("sha256", localWebhookSecret(environment)).update(rawBody).digest("hex");
}

function verifySignature(rawBody: string, signature: string, environment: string) {
  const expected = createHmac("sha256", localWebhookSecret(environment)).update(rawBody).digest("hex");
  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
  }
}

function parseVerifiedEvent(rawBody: string): VerifiedProviderBillingEvent {
  let value: unknown;
  try { value = JSON.parse(rawBody); } catch {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  if (!value || typeof value !== "object") throw new BillingAssignmentError("INVALID_REQUEST");
  const event = value as Record<string, unknown>;
  if (typeof event.providerEventId !== "string" || typeof event.eventType !== "string") {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  if (["recurring_agreement_confirmed", "recurring_agreement_failed"].includes(event.eventType)) {
    const required = ["subscriptionId", "providerSubscriptionRef", "occurredAt"];
    if (required.some((key) => typeof event[key] !== "string") ||
      (event.eventType === "recurring_agreement_confirmed" && typeof event.providerMandateRef !== "string")) {
      throw new BillingAssignmentError("INVALID_REQUEST");
    }
    return { ...event, provider: LOCAL_PROVIDER } as VerifiedProviderRecurringAgreementEvent;
  }
  const requiredStrings = ["providerPaymentRef", "currency", "priceId", "settledAt"];
  if (requiredStrings.some((key) => typeof event[key] !== "string") ||
    typeof event.amount !== "number" || !Number.isInteger(event.amount) || event.amount < 0 ||
    typeof event.priceVersion !== "number" || !Number.isInteger(event.priceVersion)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const eventType = event.eventType as VerifiedProviderPaymentEvent["eventType"];
  if (!(["initial_payment_succeeded", "initial_payment_failed", "renewal_payment_succeeded",
    "renewal_payment_failed", "renewal_failed", "retry_failed", "payment_recovered",
    "delayed_settlement"] as string[]).includes(eventType)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  return { ...event, provider: LOCAL_PROVIDER } as VerifiedProviderPaymentEvent;
}

// Local development adapter: creates only opaque provider references. It
// never treats the browser handoff as payment truth; tests/local tooling must
// send a correctly signed raw-body webhook or use reconciliation.
export const localCheckoutProviderAdapter: BillingCheckoutProviderAdapter = {
  createCheckout(input) {
    const environment = process.env.BILLING_LOCAL_ENVIRONMENT === "production" ? "production" : "test";
    const providerCheckoutRef = `local_checkout_${randomUUID()}`;
    return {
      provider: LOCAL_PROVIDER,
      environment,
      accountId: expectedLocalAccount(environment),
      providerCheckoutRef,
      providerSubscriptionRef: input.autoRenewEnabled ? `local_subscription_${randomUUID()}` : undefined,
      providerMandateRef: input.autoRenewEnabled ? `local_mandate_${randomUUID()}` : undefined,
      handoff: {
        url: `/billing/provider-handoff/${encodeURIComponent(providerCheckoutRef)}?intent=${encodeURIComponent(input.checkoutIntentId)}`,
        method: "GET",
      },
    };
  },
  verifyWebhook({ rawBody, signature, environment, accountId }) {
    if (!(environment === "test" || environment === "production") ||
      !accountId || accountId !== expectedLocalAccount(environment)) {
      throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
    }
    verifySignature(rawBody, signature, environment);
    const event = parseVerifiedEvent(rawBody);
    return { ...event, environment, accountId };
  },
  disableAutoRenewal() { return { confirmed: true }; },
  getRecurringAgreementStatus(input) {
    return { status: input.providerMandateRef ? "valid" : "invalid" };
  },
  enableAutoRenewal() { return { confirmed: true }; },
  createRecurringAgreementSetupSession(input) {
    const providerSessionRef = `local_recurring_setup_${randomUUID()}`;
    return { providerSessionRef,
      handoffUrl: `/billing/provider-handoff/${encodeURIComponent(providerSessionRef)}?subscription=${encodeURIComponent(input.subscriptionId)}&mode=recurring-setup`,
      expiresAt: input.expiresAt };
  },
  createPaymentMethodUpdateSession(input) {
    const providerSessionRef = `local_payment_update_${randomUUID()}`;
    return { providerSessionRef,
      handoffUrl: `/billing/provider-handoff/${encodeURIComponent(providerSessionRef)}?subscription=${encodeURIComponent(input.subscriptionId)}&mode=payment-update`,
      expiresAt: input.expiresAt };
  },
  stopRenewalRetries() { return { confirmed: true }; },
  listReconciliationEvents() { return { events: [], nextCursor: null }; },
};

export function resolveBillingProviderAdapter(provider: string): BillingCheckoutProviderAdapter {
  if (provider === LOCAL_PROVIDER) return localCheckoutProviderAdapter;
  throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
}
