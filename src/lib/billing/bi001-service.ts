import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import type { ProductPriceRow, ProductRow, Subscription } from "@/lib/db/types";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import { assertProcessorFieldsApproved } from "@/lib/privacy/processor-register";
import {
  localCheckoutProviderAdapter,
  type BillingCheckoutProviderAdapter,
} from "@/lib/billing/provider-adapter";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";

const ELIGIBLE_REASSIGNMENT_STATUSES = new Set(["active", "past_due"]);
const OVERLAP_STATUSES = ["active", "cancelling", "past_due"] as const;
const RESERVED_SESSION_STATUSES = ["starting", "active", "disconnected"] as const;
const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const KNOWN_CATALOG_APP_KEYS: Readonly<Record<string, string>> = {
  chess: "chess-master",
  "magical-math": "magical-math",
  "speed-reading": "speed-reader",
};

type CheckoutIntentRow = {
  id: string;
  purchaser_parent_id: string;
  assigned_learner_id: string;
  product_id: string;
  product_version: number;
  price_id: string | null;
  price_version: number | null;
  amount: number | null;
  currency: string | null;
  billing_interval: "month" | "year" | null;
  interval_count: number | null;
  auto_renew_enabled: number | null;
  consent_disclosure_version: string | null;
  consented_at: string | null;
  provider: string;
  provider_environment: "test" | "production" | null;
  provider_account_id: string | null;
  provider_checkout_ref: string;
  provider_mandate_ref: string | null;
  provider_handoff_json: string;
  status: "pending_provider" | "payment_failed" | "activated" | "expired";
  idempotency_key: string;
  request_hash: string;
  expires_at: string;
  subscription_id: string | null;
  created_at: string;
  updated_at: string;
};

type ReassignmentCaseRow = {
  id: string;
  purchaser_parent_id: string;
  subscription_id: string;
  source_learner_id: string;
  target_learner_id: string;
  reason_code: string;
  notes: string | null;
  status: "open" | "scheduled" | "executed" | "rejected" | "closed" | "expired";
  requested_effective_mode: "immediate_if_unused" | "next_period" | null;
  effective_at: string | null;
  administrator_id: string | null;
  resolution_code: string | null;
  version: number;
  idempotency_key: string;
  request_hash: string;
  requested_at: string;
  reviewed_at: string | null;
  executed_at: string | null;
  updated_at: string;
};

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function requireText(value: string, code = "INVALID_REQUEST") {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new BillingAssignmentError(code);
  return normalized;
}

function requirePositiveVersion(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new BillingAssignmentError("INVALID_REQUEST");
  return value;
}

async function productRow(productId: string): Promise<ProductRow> {
  const product = await resolveDbClient().get<ProductRow>("select * from products where id=?", [productId]);
  if (!product || product.status !== "active") throw new BillingAssignmentError("PRODUCT_NOT_AVAILABLE");
  return product;
}

export async function productAppIds(productId: string, version: number): Promise<string[]> {
  const rows = await resolveDbClient().all<{ app_id: string }>(
    `select pva.app_id from product_version_apps pva
     join app_registry ar on ar.id=pva.app_id
     where pva.product_id=? and pva.product_version=? and ar.registry_status='active'
     order by pva.app_id`,
    [productId, version],
  );
  const product = await productRow(productId);
  if (product.version !== version || rows.length === 0 || (product.product_type === "individual_app" && rows.length !== 1)) {
    throw new BillingAssignmentError("PRODUCT_NOT_AVAILABLE");
  }
  return rows.map((row) => row.app_id);
}

async function activeProductPrice(productId: string, priceId?: string, priceVersion?: number,
  now = new Date()): Promise<ProductPriceRow> {
  const nowIso = now.toISOString();
  const row = priceId
    ? await resolveDbClient().get<ProductPriceRow>(
      `select * from product_prices where id=? and product_id=? and status='active'
       and (effective_to is null or effective_to>?)`,
      [priceId, productId, nowIso],
    )
    : await resolveDbClient().get<ProductPriceRow>(
      `select * from product_prices where product_id=? and status='active'
       and (effective_to is null or effective_to>?) order by version desc limit 1`,
      [productId, nowIso],
    );
  if (!row || (priceVersion !== undefined && row.version !== priceVersion)) {
    throw new BillingAssignmentError("PRODUCT_NOT_AVAILABLE");
  }
  return row;
}

// UL-001: a boolean-returning sibling of assertNoProductAccessOverlap below,
// sharing this exact overlap query rather than duplicating it — Subscribe
// Again's eligibility check needs a yes/no answer, not a throw.
export async function hasProductAccessOverlap(learnerId: string, productId: string, productVersion: number,
  now = new Date()): Promise<boolean> {
  const appIds = await productAppIds(productId, productVersion);
  const appPlaceholders = appIds.map(() => "?").join(",");
  const effective = await resolveDbClient().get(
    `select 1 from learner_app_effective_entitlements where learner_id=? and app_id in (${appPlaceholders})
     and environment='production' and state in ('active','approved_grace') and access_until>? limit 1`,
    [learnerId, ...appIds, now.toISOString()],
  );
  if (effective) return true;
  const candidates = await resolveDbClient().all<{ id: string; product_id: string; product_version: number }>(
    `select id,product_id,product_version from subscriptions where assigned_learner_id=?
     and status in ('active','cancelling','past_due')`,
    [learnerId],
  );
  for (const candidate of candidates) {
    const candidateAppIds = await productAppIds(candidate.product_id, candidate.product_version);
    if (candidateAppIds.some((appId) => appIds.includes(appId))) return true;
  }
  return false;
}

export async function assertNoProductAccessOverlap(learnerId: string, productId: string, productVersion: number,
  now = new Date()): Promise<string> {
  if (await hasProductAccessOverlap(learnerId, productId, productVersion, now)) {
    throw new BillingAssignmentError("PRODUCT_ACCESS_OVERLAP");
  }
  const appIds = await productAppIds(productId, productVersion);
  return createHash("sha256").update(JSON.stringify(appIds)).digest("hex");
}

async function assertOwnedLearner(parentId: string, learnerId: string) {
  const row = await resolveDbClient().get(
    `select l.id from learners l join profiles p on p.id=l.owner_parent_id
     where l.id=? and l.owner_parent_id=? and p.account_status='active'`,
    [learnerId, parentId],
  );
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
}

async function checkoutResponse(row: CheckoutIntentRow) {
  const db = resolveDbClient();
  const product = await db.get<{ name: string; product_type: string }>(
    "select name,product_type from products where id=?", [row.product_id]) as
    { name: string; product_type: string };
  const learner = await db.get<{ display_name: string }>(
    "select display_name from learners where id=?", [row.assigned_learner_id]) as { display_name: string };
  const apps = await db.all<{ id: string; display_name: string }>(
    `select ar.id,ar.display_name from product_version_apps pva join app_registry ar on ar.id=pva.app_id
     where pva.product_id=? and pva.product_version=? order by ar.display_name`,
    [row.product_id, row.product_version],
  );
  return {
    checkoutIntentId: row.id,
    status: row.status,
    purchaserParentId: row.purchaser_parent_id,
    assignedLearner: { id: row.assigned_learner_id, displayName: learner.display_name },
    product: { id: row.product_id, name: product.name, productType: product.product_type,
      version: row.product_version, includedApps: apps.map((app) => ({ id: app.id, name: app.display_name })) },
    assignmentLockedAfterActivation: true,
    price: row.price_id ? {
      id: row.price_id,
      version: row.price_version,
      amount: row.amount,
      currency: row.currency,
      billingInterval: row.billing_interval,
      intervalCount: row.interval_count,
    } : null,
    autoRenewEnabled: row.auto_renew_enabled === null ? null : row.auto_renew_enabled === 1,
    consentDisclosureVersion: row.consent_disclosure_version,
    consentedAt: row.consented_at,
    nextRenewalRule: row.auto_renew_enabled === 1
      ? `Every ${row.interval_count ?? 1} calendar ${row.billing_interval ?? "month"}(s) from verified activation`
      : null,
    provider: row.provider,
    providerCheckoutRef: row.provider_checkout_ref,
    providerHandoff: JSON.parse(row.provider_handoff_json),
    expiresAt: row.expires_at,
    subscriptionId: row.subscription_id,
  };
}

async function ensureDefaultProductPrice(productId: string, productVersion: number, priceInr: number,
  now = new Date()): Promise<ProductPriceRow> {
  const db = resolveDbClient();
  const id = `price:${productId}:INR:month:v${productVersion}`;
  const existing = await db.get<ProductPriceRow>("select * from product_prices where id=?", [id]);
  if (existing) {
    if (existing.unit_amount !== priceInr * 100 || existing.version !== productVersion) {
      throw new BillingAssignmentError("PRODUCT_VERSION_CONFLICT");
    }
    return existing;
  }
  await db.run(
    `insert into product_prices(id,product_id,currency,billing_interval,interval_count,unit_amount,
     pricing_rule_version,supports_non_renewing,status,effective_from,version)
     values(?,?,'INR','month',1,?, ?,1,'active',?,?)`,
    [id, productId, priceInr * 100, `product-v${productVersion}`, now.toISOString(), productVersion],
  );
  return await db.get<ProductPriceRow>("select * from product_prices where id=?", [id]) as ProductPriceRow;
}

export async function defineProductVersion(input: {
  id?: string;
  slug: string;
  name: string;
  subdomain: string;
  planReference: string;
  priceInr: number;
  productType: "individual_app" | "bundle";
  version: number;
  appIds: string[];
  status?: "active" | "coming_soon" | "archived";
}) {
  const slug = requireText(input.slug);
  const name = requireText(input.name);
  const version = requirePositiveVersion(input.version);
  const appIds = [...new Set(input.appIds)].sort();
  if (!Number.isInteger(input.priceInr) || input.priceInr < 0 || appIds.length === 0 ||
    (input.productType === "individual_app" && appIds.length !== 1)) {
    throw new BillingAssignmentError("INVALID_PRODUCT_DEFINITION");
  }
  for (const appId of appIds) {
    const app = await resolveDbClient().get(
      "select 1 from app_registry where id=? and registry_status='active'", [appId]);
    if (!app) throw new BillingAssignmentError("PRODUCT_NOT_AVAILABLE");
  }
  return resolveDbClient().transaction(async (db) => {
    const existing = await db.get<ProductRow>("select * from products where slug=?", [slug]);
    if (existing && (existing.id !== (input.id ?? existing.id) || existing.version === version)) {
      const existingApps = (await db.all<{ app_id: string }>(
        "select app_id from product_version_apps where product_id=? and product_version=? order by app_id",
        [existing.id, version],
      )).map((row) => row.app_id);
      const same = existing.version === version && existing.name === name && existing.product_type === input.productType &&
        JSON.stringify(existingApps) === JSON.stringify(appIds);
      if (!same) throw new BillingAssignmentError("PRODUCT_VERSION_CONFLICT");
      await ensureDefaultProductPrice(existing.id, version, input.priceInr);
      return existing;
    }
    const id = existing?.id ?? input.id ?? randomUUID();
    if (existing) {
      await db.run(
        `update products set name=?,subdomain=?,razorpay_plan_id=?,price_inr=?,product_type=?,version=?,status=? where id=?`,
        [name, requireText(input.subdomain), requireText(input.planReference), input.priceInr,
          input.productType, version, input.status ?? "active", id],
      );
    } else {
      await db.run(
        `insert into products(id,slug,name,subdomain,razorpay_plan_id,price_inr,product_type,version,status)
         values(?,?,?,?,?,?,?,?,?)`,
        [id, slug, name, requireText(input.subdomain), requireText(input.planReference), input.priceInr,
          input.productType, version, input.status ?? "active"],
      );
    }
    for (const appId of appIds) {
      await db.run("insert into product_version_apps(product_id,product_version,app_id) values(?,?,?)",
        [id, version, appId]);
    }
    await ensureDefaultProductPrice(id, version, input.priceInr);
    return await db.get<ProductRow>("select * from products where id=?", [id]) as ProductRow;
  });
}

export async function ensureKnownCatalogProductMappings() {
  return resolveDbClient().transaction(async (db) => {
    let created = 0;
    for (const [slug, appKey] of Object.entries(KNOWN_CATALOG_APP_KEYS)) {
      created += (await db.run(
        `insert into product_version_apps(product_id,product_version,app_id)
         select p.id,p.version,ar.id from products p join app_registry ar on ar.app_key=? where p.slug=?
         on conflict(product_id,product_version,app_id) do nothing`,
        [appKey, slug],
      )).changes;
    }
    return created;
  });
}

export async function getProductPurchaseView(productId: string) {
  const product = await productRow(productId);
  const appIds = await productAppIds(product.id, product.version);
  const placeholders = appIds.map(() => "?").join(",");
  const apps = await resolveDbClient().all<{ id: string; display_name: string }>(
    `select id,display_name from app_registry where id in (${placeholders}) order by display_name`,
    [...appIds],
  );
  const price = await activeProductPrice(product.id);
  return { id: product.id, slug: product.slug, name: product.name, productType: product.product_type,
    version: product.version, priceInr: product.price_inr,
    price: { id: price.id, version: price.version, amount: price.unit_amount, currency: price.currency,
      billingInterval: price.billing_interval, intervalCount: price.interval_count,
      supportsNonRenewing: price.supports_non_renewing === 1,
      pricingRuleVersion: price.pricing_rule_version },
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION,
    includedApps: apps.map((app) => ({ id: app.id, name: app.display_name })) };
}

export async function createCheckoutIntent(parentId: string, input: {
  learnerId: string;
  productId: string;
  productVersion: number;
  priceId?: string;
  priceVersion?: number;
  autoRenewEnabled?: boolean;
  consentDisclosureVersion?: string;
  idempotencyKey: string;
}, options: { now?: Date; provider?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  const idempotencyKey = requireText(input.idempotencyKey);
  const productVersion = requirePositiveVersion(input.productVersion);
  const bi002Fields = [input.priceId, input.priceVersion, input.autoRenewEnabled, input.consentDisclosureVersion];
  const isBi002Checkout = bi002Fields.some((value) => value !== undefined);
  if (isBi002Checkout && (typeof input.priceId !== "string" || typeof input.priceVersion !== "number" ||
    typeof input.autoRenewEnabled !== "boolean" || input.consentDisclosureVersion !== BILLING_CONSENT_DISCLOSURE_VERSION)) {
    throw new BillingAssignmentError("CHECKOUT_CONSENT_INVALID");
  }
  const requestHash = hashPayload({ learnerId: input.learnerId, productId: input.productId, productVersion,
    priceId: input.priceId ?? null, priceVersion: input.priceVersion ?? null,
    autoRenewEnabled: input.autoRenewEnabled ?? null,
    consentDisclosureVersion: input.consentDisclosureVersion ?? null });
  const existing = await resolveDbClient().get<CheckoutIntentRow>(
    "select * from checkout_intents where purchaser_parent_id=? and idempotency_key=?",
    [parentId, idempotencyKey],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    return checkoutResponse(existing);
  }
  await assertOwnedLearner(parentId, input.learnerId);
  const product = await productRow(input.productId);
  if (product.version !== productVersion) throw new BillingAssignmentError("PRODUCT_NOT_AVAILABLE");
  const overlapSourceHash = isBi002Checkout
    ? await assertNoProductAccessOverlap(input.learnerId, product.id, productVersion, now)
    : createHash("sha256").update(JSON.stringify(await productAppIds(product.id, productVersion))).digest("hex");
  const price = await activeProductPrice(product.id, input.priceId, input.priceVersion, now);
  if (isBi002Checkout && input.autoRenewEnabled === false && price.supports_non_renewing !== 1) {
    throw new BillingAssignmentError("CHECKOUT_CONSENT_INVALID");
  }

  const checkoutIntentId = randomUUID();
  const provider = options.provider ?? localCheckoutProviderAdapter;
  const checkoutPayload = { checkoutIntentId, purchaserParentId: parentId,
    assignedLearnerId: input.learnerId, productId: product.id, productVersion,
    priceId: price.id, priceVersion: price.version, amount: price.unit_amount, currency: price.currency,
    billingInterval: price.billing_interval, intervalCount: price.interval_count,
    autoRenewEnabled: isBi002Checkout ? input.autoRenewEnabled : undefined };
  // PC-005: representative proof that the checkout payload never carries
  // an unregistered/unapproved field before it leaves the platform.
  assertProcessorFieldsApproved("payment_checkout",
    Object.keys(checkoutPayload).filter((key) => checkoutPayload[key as keyof typeof checkoutPayload] !== undefined));
  const handoff = provider.createCheckout(checkoutPayload);
  if (isBi002Checkout && input.autoRenewEnabled && !handoff.providerMandateRef) {
    throw new BillingAssignmentError("RECURRING_PAYMENT_SETUP_FAILED");
  }
  if (isBi002Checkout && (!handoff.environment || !handoff.accountId)) {
    throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  }
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS).toISOString();
  const pendingSubscriptionId = isBi002Checkout ? randomUUID() : null;
  return resolveDbClient().transaction(async (db) => {
    if (pendingSubscriptionId) {
      const providerSubscriptionRef = handoff.providerSubscriptionRef ?? `pending:${checkoutIntentId}`;
      await db.run(
        `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,
         product_version,status,cancel_at_period_end,auto_renew_enabled,provider,provider_environment,
         provider_account_id,razorpay_subscription_id,
         provider_customer_ref,provider_mandate_ref,provider_subscription_ref,billing_price_id,
         billing_price_version,payment_state,started_at,current_period_start,current_period_end,
         next_renewal_at,billing_anchor_at,created_at,updated_at)
         values(?,?,?,?,?,?,?,'pending_payment',0,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,null,null,?,?)`,
        [pendingSubscriptionId, parentId, product.product_type === "bundle" ? "bundle" : "single",
          product.id, parentId, input.learnerId, productVersion, input.autoRenewEnabled ? 1 : 0,
          handoff.provider, handoff.environment ?? null, handoff.accountId ?? null, providerSubscriptionRef, null,
          handoff.providerMandateRef ?? null, providerSubscriptionRef, price.id, price.version,
          timestamp, timestamp, timestamp, timestamp, timestamp],
      );
    }
    await db.run(
      `insert into checkout_intents(id,purchaser_parent_id,assigned_learner_id,product_id,product_version,
       price_id,price_version,amount,currency,billing_interval,interval_count,auto_renew_enabled,
       consent_disclosure_version,consented_at,provider,provider_environment,provider_account_id,
       provider_checkout_ref,provider_mandate_ref,
       provider_handoff_json,overlap_source_hash,status,idempotency_key,request_hash,expires_at,
       subscription_id,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_provider',?,?,?,?,?,?)`,
      [checkoutIntentId, parentId, input.learnerId, product.id, productVersion, price.id, price.version,
        price.unit_amount, price.currency, price.billing_interval, price.interval_count,
        isBi002Checkout ? (input.autoRenewEnabled ? 1 : 0) : null,
        isBi002Checkout ? input.consentDisclosureVersion ?? null : null,
        isBi002Checkout ? timestamp : null, handoff.provider,
        handoff.environment ?? null, handoff.accountId ?? null,
        handoff.providerCheckoutRef, handoff.providerMandateRef ?? null,
        JSON.stringify(handoff.handoff), overlapSourceHash, idempotencyKey,
        requestHash, expiresAt, pendingSubscriptionId, timestamp, timestamp],
    );
    await db.run(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'checkout_intent_created',?)",
      [randomUUID(), parentId, JSON.stringify({ checkoutIntentId, learnerId: input.learnerId,
        productId: product.id, productVersion, priceId: price.id, priceVersion: price.version,
        amount: price.unit_amount, currency: price.currency,
        autoRenewEnabled: isBi002Checkout ? input.autoRenewEnabled : null })],
    );
    return checkoutResponse(
      await db.get<CheckoutIntentRow>("select * from checkout_intents where id=?", [checkoutIntentId]) as CheckoutIntentRow);
  });
}

export type VerifiedCheckoutPayment = {
  provider: string;
  providerEventId: string;
  checkoutIntentId: string;
  providerCheckoutRef: string;
  purchaserParentId: string;
  assignedLearnerId: string;
  productId: string;
  productVersion: number;
  paymentStatus: "paid" | "failed";
  providerSubscriptionRef: string;
  providerCustomerRef?: string;
  periodStart: string;
  periodEnd: string;
};

export async function applyVerifiedCheckoutPayment(input: VerifiedCheckoutPayment, now = new Date()) {
  const requestHash = hashPayload(input);
  const db = resolveDbClient();
  const receipt = await db.get<{ request_hash: string; response_json: string | null }>(
    "select request_hash,response_json from checkout_activation_receipts where provider=? and provider_event_id=?",
    [input.provider, input.providerEventId],
  );
  if (receipt) {
    if (receipt.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    return receipt.response_json ? JSON.parse(receipt.response_json) : null;
  }
  const intent = await db.get<CheckoutIntentRow>(
    "select * from checkout_intents where id=?", [input.checkoutIntentId]);
  if (!intent) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  const exactContext = intent.provider === input.provider && intent.provider_checkout_ref === input.providerCheckoutRef &&
    intent.purchaser_parent_id === input.purchaserParentId && intent.assigned_learner_id === input.assignedLearnerId &&
    intent.product_id === input.productId && intent.product_version === input.productVersion;
  if (!exactContext) throw new BillingAssignmentError("CHECKOUT_CONTEXT_MISMATCH");
  if (input.paymentStatus === "failed") {
    return resolveDbClient().transaction(async (tx) => {
      await tx.run("update checkout_intents set status='payment_failed',updated_at=? where id=? and status='pending_provider'",
        [now.toISOString(), intent.id]);
      await tx.run(
        `insert into checkout_activation_receipts(provider,provider_event_id,request_hash,checkout_intent_id,
         result_code,response_json,created_at) values(?,?,?,?, 'PAYMENT_FAILED',null,?)`,
        [input.provider, input.providerEventId, requestHash, intent.id, now.toISOString()],
      );
      return null;
    });
  }
  if (intent.status !== "pending_provider") throw new BillingAssignmentError("CHECKOUT_CONTEXT_MISMATCH");
  if (now >= new Date(intent.expires_at)) throw new BillingAssignmentError("CHECKOUT_CONTEXT_MISMATCH");
  const periodStart = new Date(input.periodStart);
  const periodEnd = new Date(input.periodEnd);
  if (!Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime()) || periodEnd <= periodStart) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  await assertOwnedLearner(input.purchaserParentId, input.assignedLearnerId);
  const product = await productRow(input.productId);
  if (product.version !== input.productVersion) throw new BillingAssignmentError("CHECKOUT_CONTEXT_MISMATCH");
  await productAppIds(product.id, product.version);
  const subscriptionId = randomUUID();
  const timestamp = now.toISOString();
  const summary = {
    subscriptionId,
    purchaserParentId: input.purchaserParentId,
    assignedLearnerId: input.assignedLearnerId,
    productId: input.productId,
    productVersion: input.productVersion,
    status: "active",
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
  };
  return resolveDbClient().transaction(async (tx) => {
    await tx.run(
      `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,
       status,razorpay_subscription_id,provider_customer_ref,started_at,current_period_start,current_period_end,
       created_at,updated_at) values(?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`,
      [subscriptionId, input.purchaserParentId, product.product_type === "bundle" ? "bundle" : "single",
        product.id, input.purchaserParentId, input.assignedLearnerId, input.productVersion,
        input.providerSubscriptionRef, input.providerCustomerRef ?? null, periodStart.toISOString(),
        periodStart.toISOString(), periodEnd.toISOString(), timestamp, timestamp],
    );
    await tx.run("update checkout_intents set status='activated',subscription_id=?,updated_at=? where id=?",
      [subscriptionId, timestamp, intent.id]);
    await tx.run(
      `insert into checkout_activation_receipts(provider,provider_event_id,request_hash,checkout_intent_id,
       subscription_id,result_code,response_json,created_at) values(?,?,?,?,?,'ACTIVATED',?,?)`,
      [input.provider, input.providerEventId, requestHash, intent.id, subscriptionId, JSON.stringify(summary), timestamp],
    );
    await insertAssignmentAudit({ subscriptionId, eventType: "subscription_activated", actorType: "billing_service",
      actorId: input.provider, purchaserParentId: input.purchaserParentId, sourceLearnerId: null,
      targetLearnerId: input.assignedLearnerId, productId: product.id, effectiveAt: periodStart.toISOString(),
      resultCode: "ACTIVATED", now });
    await emitAssignmentEvent(input.purchaserParentId, "subscription_activated", { subscriptionId,
      learnerId: input.assignedLearnerId, productId: product.id, productVersion: product.version,
      effectiveAt: periodStart.toISOString(), assignmentVersion: 1 });
    return summary;
  });
}

async function safeSubscriptionSummary(row: Subscription) {
  const db = resolveDbClient();
  const details = await db.get<{ learner_name: string; product_name: string; product_type: string }>(
    `select l.display_name learner_name,p.name product_name,p.product_type
     from learners l join products p on p.id=? where l.id=?`,
    [row.product_id, row.assigned_learner_id],
  ) as { learner_name: string; product_name: string; product_type: string };
  const apps = await db.all<{ id: string; display_name: string }>(
    `select ar.id,ar.display_name from product_version_apps pva join app_registry ar on ar.id=pva.app_id
     where pva.product_id=? and pva.product_version=? order by ar.display_name`,
    [row.product_id, row.product_version],
  );
  const price = row.billing_price_id ? await db.get<{ unit_amount: number; currency: string }>(
    "select unit_amount,currency from product_prices where id=? and version=?",
    [row.billing_price_id, row.billing_price_version],
  ) : undefined;
  return {
    id: row.id,
    purchaserParentId: row.purchaser_parent_id,
    assignedLearner: { id: row.assigned_learner_id, displayName: details.learner_name },
    product: { id: row.product_id, name: details.product_name, productType: details.product_type,
      version: row.product_version, includedApps: apps.map((app) => ({ id: app.id, name: app.display_name })) },
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    paymentState: row.payment_state,
    graceStartedAt: row.grace_started_at,
    graceEndsAt: row.grace_ends_at,
    nonpaymentEndedAt: row.nonpayment_ended_at,
    autoRenewEnabled: row.auto_renew_enabled === 1,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    cancellationEffectiveAt: row.cancellation_effective_at,
    canResumeAutoRenew: row.cancel_at_period_end === 1 && row.status === "active",
    providerMandateStatus: row.provider_mandate_status,
    nextRenewalAt: row.next_renewal_at,
    billingPrice: row.billing_price_id ? { id: row.billing_price_id, version: row.billing_price_version,
      amount: price?.unit_amount ?? null, currency: price?.currency ?? null } : null,
    pendingReassignment: row.pending_reassignment_learner_id ? {
      learnerId: row.pending_reassignment_learner_id,
      effectiveAt: row.pending_reassignment_effective_at,
    } : null,
    assignmentVersion: row.assignment_version,
    version: row.version,
    assignmentSelfServiceEditable: false,
  };
}

export async function listParentSubscriptions(parentId: string, input: { status?: string; cursor?: string; limit?: number } = {}) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const params: (string | number)[] = [parentId];
  const clauses = ["purchaser_parent_id=?", "assigned_learner_id is not null", "product_id is not null"];
  if (input.status) {
    clauses.push("status=?");
    params.push(input.status);
  }
  if (input.cursor) {
    clauses.push("id>?");
    params.push(input.cursor);
  }
  params.push(limit + 1);
  const rows = await resolveDbClient().all<Subscription>(
    `select * from subscriptions where ${clauses.join(" and ")} order by id limit ?`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = [];
  for (const row of page) items.push(await safeSubscriptionSummary(row));
  return { items, nextCursor: hasMore ? page.at(-1)!.id : null };
}

async function subscriptionForPurchaser(parentId: string, subscriptionId: string): Promise<Subscription> {
  const row = await resolveDbClient().get<Subscription>(
    "select * from subscriptions where id=? and purchaser_parent_id=?", [subscriptionId, parentId]);
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return row;
}

export async function createReassignmentCase(parentId: string, input: {
  subscriptionId: string;
  targetLearnerId: string;
  reasonCode: string;
  notes?: string;
  idempotencyKey: string;
}, now = new Date()) {
  const reasonCode = requireText(input.reasonCode);
  const idempotencyKey = requireText(input.idempotencyKey);
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 1000) throw new BillingAssignmentError("INVALID_REQUEST");
  const requestHash = hashPayload({ subscriptionId: input.subscriptionId, targetLearnerId: input.targetLearnerId,
    reasonCode, notes });
  const existing = await resolveDbClient().get<ReassignmentCaseRow>(
    "select * from subscription_reassignment_cases where purchaser_parent_id=? and idempotency_key=?",
    [parentId, idempotencyKey],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    return safeCaseSummary(existing);
  }
  const subscription = await subscriptionForPurchaser(parentId, input.subscriptionId);
  await assertOwnedLearner(parentId, input.targetLearnerId);
  if (subscription.assigned_learner_id === input.targetLearnerId) throw new BillingAssignmentError("INVALID_REQUEST");
  const timestamp = now.toISOString();
  const caseId = randomUUID();
  return resolveDbClient().transaction(async (db) => {
    await db.run(
      `insert into subscription_reassignment_cases(id,purchaser_parent_id,subscription_id,source_learner_id,
       target_learner_id,reason_code,notes,status,version,idempotency_key,request_hash,requested_at,updated_at)
       values(?,?,?,?,?,?,?,'open',1,?,?,?,?)`,
      [caseId, parentId, subscription.id, subscription.assigned_learner_id, input.targetLearnerId,
        reasonCode, notes, idempotencyKey, requestHash, timestamp, timestamp],
    );
    await insertAssignmentAudit({ subscriptionId: subscription.id, caseId, eventType: "reassignment_case_created",
      actorType: "parent", actorId: parentId, purchaserParentId: parentId,
      sourceLearnerId: subscription.assigned_learner_id, targetLearnerId: input.targetLearnerId,
      productId: subscription.product_id, effectiveAt: null, resultCode: "OPEN", now });
    await emitAssignmentEvent(parentId, "subscription_reassignment_case_created", { caseId,
      subscriptionId: subscription.id, sourceLearnerId: subscription.assigned_learner_id,
      targetLearnerId: input.targetLearnerId });
    return safeCaseSummary(await db.get<ReassignmentCaseRow>(
      "select * from subscription_reassignment_cases where id=?", [caseId]) as ReassignmentCaseRow);
  });
}

async function hasTargetOverlap(subscription: Subscription, targetLearnerId: string): Promise<boolean> {
  const appIds = await productAppIds(subscription.product_id, subscription.product_version);
  const placeholders = OVERLAP_STATUSES.map(() => "?").join(",");
  const candidates = await resolveDbClient().all<{ id: string; product_id: string; product_version: number }>(
    `select id,product_id,product_version from subscriptions
     where assigned_learner_id=? and id<>? and status in (${placeholders})`,
    [targetLearnerId, subscription.id, ...OVERLAP_STATUSES],
  );
  for (const candidate of candidates) {
    const otherApps = await productAppIds(candidate.product_id, candidate.product_version);
    if (otherApps.some((appId) => appIds.includes(appId))) return true;
  }
  return false;
}

async function hasAffectedReservedSession(subscription: Subscription, targetLearnerId: string): Promise<boolean> {
  const appIds = await productAppIds(subscription.product_id, subscription.product_version);
  const appPlaceholders = appIds.map(() => "?").join(",");
  const statusPlaceholders = RESERVED_SESSION_STATUSES.map(() => "?").join(",");
  return !!(await resolveDbClient().get(
    `select 1 from learner_sessions where learner_id in (?,?) and app_id in (${appPlaceholders})
     and status in (${statusPlaceholders}) limit 1`,
    [subscription.assigned_learner_id, targetLearnerId, ...appIds, ...RESERVED_SESSION_STATUSES],
  ));
}

async function subscriptionHasUsableLearning(subscription: Subscription): Promise<boolean> {
  const db = resolveDbClient();
  const direct = await db.get(
    `select 1 from learner_sessions ls
     left join learner_app_entitlement_periods ep on ep.id=ls.allocation_source_entitlement_period_id
     left join entitlement_cycles ec on ec.id=ep.entitlement_cycle_id
     where (ec.subscription_id=? or (ec.id is null and ls.learner_id=? and ls.started_at>=? and ls.started_at<?))
       and (ls.usable_launch_established_at is not null or ls.funding_state='consumed') limit 1`,
    [subscription.id, subscription.assigned_learner_id, subscription.current_period_start, subscription.current_period_end],
  );
  if (direct) return true;
  return !!(await db.get(
    `select 1 from learner_app_standard_credit_batches b
     join learner_app_entitlement_periods ep on ep.id=b.entitlement_period_id
     join entitlement_cycles ec on ec.id=ep.entitlement_cycle_id
     where ec.subscription_id=? and b.consumed_count>0 limit 1`,
    [subscription.id],
  ));
}

async function validateReassignment(subscription: Subscription, targetLearnerId: string) {
  if (!ELIGIBLE_REASSIGNMENT_STATUSES.has(subscription.status)) {
    throw new BillingAssignmentError("SUBSCRIPTION_REASSIGNMENT_NOT_ALLOWED");
  }
  await assertOwnedLearner(subscription.purchaser_parent_id, subscription.assigned_learner_id);
  await assertOwnedLearner(subscription.purchaser_parent_id, targetLearnerId);
  if (await hasTargetOverlap(subscription, targetLearnerId)) throw new BillingAssignmentError("TARGET_SUBSCRIPTION_CONFLICT");
  if (await hasAffectedReservedSession(subscription, targetLearnerId)) throw new BillingAssignmentError("LEARNER_SESSION_IN_PROGRESS");
}

function safeCaseSummary(row: ReassignmentCaseRow) {
  return {
    caseId: row.id,
    purchaserParentId: row.purchaser_parent_id,
    subscriptionId: row.subscription_id,
    sourceLearnerId: row.source_learner_id,
    targetLearnerId: row.target_learner_id,
    reasonCode: row.reason_code,
    status: row.status,
    requestedEffectiveMode: row.requested_effective_mode,
    effectiveAt: row.effective_at,
    resolutionCode: row.resolution_code,
    version: row.version,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    executedAt: row.executed_at,
  };
}

export async function getAdminReassignmentCase(caseId: string) {
  const db = resolveDbClient();
  const row = await db.get<ReassignmentCaseRow>(
    "select * from subscription_reassignment_cases where id=?", [caseId]);
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  const subscription = await db.get<Subscription>(
    "select * from subscriptions where id=?", [row.subscription_id]) as Subscription;
  let validationCode: string | null = null;
  try { await validateReassignment(subscription, row.target_learner_id); } catch (error) {
    validationCode = error instanceof BillingAssignmentError ? error.code : "SUBSCRIPTION_REASSIGNMENT_NOT_ALLOWED";
  }
  const usableLearning = await subscriptionHasUsableLearning(subscription);
  return {
    ...safeCaseSummary(row),
    subscription: await safeSubscriptionSummary(subscription),
    eligibility: {
      valid: row.status === "open" && validationCode === null,
      validationCode: row.status === "open" ? validationCode : "CASE_NOT_ACTIVE",
      hasUsableLearningOrConsumedCredit: usableLearning,
      immediateCorrectionAllowed: row.status === "open" && validationCode === null && !usableLearning,
      nextPeriodEffectiveAt: subscription.current_period_end,
    },
  };
}

export type ReassignmentEffectiveMode = "immediate_if_unused" | "next_period";

export async function executeSubscriptionReassignment(adminId: string, subscriptionId: string, input: {
  caseId: string;
  targetLearnerId: string;
  effectiveMode: ReassignmentEffectiveMode;
  reasonCode: string;
  expectedSubscriptionVersion: number;
  expectedCaseVersion: number;
  idempotencyKey: string;
}, now = new Date()) {
  const idempotencyKey = requireText(input.idempotencyKey);
  const reasonCode = requireText(input.reasonCode);
  const requestHash = hashPayload({ subscriptionId, caseId: input.caseId, targetLearnerId: input.targetLearnerId,
    effectiveMode: input.effectiveMode, reasonCode, expectedSubscriptionVersion: input.expectedSubscriptionVersion,
    expectedCaseVersion: input.expectedCaseVersion });
  const db = resolveDbClient();
  const receipt = await db.get<{ request_hash: string; response_json: string | null }>(
    "select request_hash,response_json from subscription_reassignment_requests where administrator_id=? and idempotency_key=?",
    [adminId, idempotencyKey],
  );
  if (receipt) {
    if (receipt.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(receipt.response_json!);
  }
  const row = await db.get<ReassignmentCaseRow>(
    "select * from subscription_reassignment_cases where id=?", [input.caseId]);
  if (!row || row.subscription_id !== subscriptionId) throw new BillingAssignmentError("REASSIGNMENT_CASE_REQUIRED");
  const subscription = await db.get<Subscription>("select * from subscriptions where id=?", [subscriptionId]);
  if (!subscription) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  if (row.status !== "open") throw new BillingAssignmentError("CASE_NOT_ACTIVE");
  if (row.target_learner_id !== input.targetLearnerId || row.source_learner_id !== subscription.assigned_learner_id ||
    row.purchaser_parent_id !== subscription.purchaser_parent_id || row.reason_code !== reasonCode) {
    throw new BillingAssignmentError("REASSIGNMENT_CASE_REQUIRED");
  }
  if (subscription.version !== input.expectedSubscriptionVersion || row.version !== input.expectedCaseVersion) {
    throw new BillingAssignmentError("VERSION_CONFLICT");
  }
  if (!(["immediate_if_unused", "next_period"] as string[]).includes(input.effectiveMode)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  await validateReassignment(subscription, input.targetLearnerId);
  const used = await subscriptionHasUsableLearning(subscription);
  if (input.effectiveMode === "immediate_if_unused" && used) {
    throw new BillingAssignmentError("REASSIGNMENT_SCHEDULE_REQUIRED");
  }
  const timestamp = now.toISOString();
  const effectiveAt = input.effectiveMode === "immediate_if_unused" ? timestamp : subscription.current_period_end;
  if (input.effectiveMode === "next_period" && effectiveAt <= timestamp) {
    throw new BillingAssignmentError("SUBSCRIPTION_REASSIGNMENT_NOT_ALLOWED");
  }
  return resolveDbClient().transaction(async (tx) => {
    await tx.run(
      `insert into subscription_reassignment_requests(administrator_id,idempotency_key,case_id,subscription_id,
       request_hash,status,created_at) values(?,?,?,?,?,'processing',?)`,
      [adminId, idempotencyKey, row.id, subscription.id, requestHash, timestamp],
    );
    let result: Record<string, unknown>;
    if (input.effectiveMode === "immediate_if_unused") {
      const changed = (await tx.run(
        `update subscriptions set assigned_learner_id=?,assignment_version=assignment_version+1,
         version=version+1,updated_at=? where id=? and version=? and assigned_learner_id=?`,
        [input.targetLearnerId, timestamp, subscription.id, subscription.version, subscription.assigned_learner_id],
      )).changes;
      if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
      await tx.run(
        `update subscription_reassignment_cases set status='executed',requested_effective_mode='immediate_if_unused',
         effective_at=?,administrator_id=?,resolution_code='IMMEDIATE_UNUSED_CORRECTION',reviewed_at=?,executed_at=?,
         version=version+1,updated_at=? where id=? and status='open' and version=?`,
        [timestamp, adminId, timestamp, timestamp, timestamp, row.id, row.version],
      );
      result = { caseId: row.id, subscriptionId: subscription.id, status: "executed", effectiveMode: input.effectiveMode,
        effectiveAt: timestamp, purchaserParentId: subscription.purchaser_parent_id,
        sourceLearnerId: subscription.assigned_learner_id, targetLearnerId: input.targetLearnerId,
        assignmentVersion: subscription.assignment_version + 1, subscriptionVersion: subscription.version + 1,
        caseVersion: row.version + 1 };
      await recordReassignmentTransition(subscription, row.id, adminId, input.targetLearnerId, timestamp,
        "reassignment_executed", "IMMEDIATE_UNUSED_CORRECTION", now, subscription.assignment_version + 1);
    } else {
      const changed = (await tx.run(
        `update subscriptions set pending_reassignment_learner_id=?,pending_reassignment_effective_at=?,
         version=version+1,updated_at=? where id=? and version=? and pending_reassignment_learner_id is null`,
        [input.targetLearnerId, effectiveAt, timestamp, subscription.id, subscription.version],
      )).changes;
      if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
      await tx.run(
        `update subscription_reassignment_cases set status='scheduled',requested_effective_mode='next_period',
         effective_at=?,administrator_id=?,resolution_code='NEXT_PERIOD_SCHEDULED',reviewed_at=?,version=version+1,
         updated_at=? where id=? and status='open' and version=?`,
        [effectiveAt, adminId, timestamp, timestamp, row.id, row.version],
      );
      result = { caseId: row.id, subscriptionId: subscription.id, status: "scheduled", effectiveMode: input.effectiveMode,
        effectiveAt, purchaserParentId: subscription.purchaser_parent_id,
        sourceLearnerId: subscription.assigned_learner_id, targetLearnerId: input.targetLearnerId,
        assignmentVersion: subscription.assignment_version, subscriptionVersion: subscription.version + 1,
        caseVersion: row.version + 1 };
      await recordReassignmentTransition(subscription, row.id, adminId, input.targetLearnerId, effectiveAt,
        "reassignment_scheduled", "NEXT_PERIOD_SCHEDULED", now, subscription.assignment_version);
    }
    await tx.run(
      `update subscription_reassignment_requests set status='completed',response_json=?,completed_at=?
       where administrator_id=? and idempotency_key=?`,
      [JSON.stringify(result), timestamp, adminId, idempotencyKey],
    );
    return result;
  });
}

async function insertAssignmentAudit(input: {
  subscriptionId: string;
  caseId?: string;
  eventType: "subscription_activated" | "reassignment_case_created" | "reassignment_scheduled" | "reassignment_executed";
  actorType: "parent" | "administrator" | "billing_service";
  actorId: string;
  purchaserParentId: string;
  sourceLearnerId: string | null;
  targetLearnerId: string | null;
  productId: string;
  effectiveAt: string | null;
  resultCode: string;
  now: Date;
}) {
  await resolveDbClient().run(
    `insert into subscription_assignment_audit(id,subscription_id,case_id,event_type,actor_type,actor_id,
     purchaser_parent_id,source_learner_id,target_learner_id,product_id,effective_at,result_code,created_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), input.subscriptionId, input.caseId ?? null, input.eventType, input.actorType, input.actorId,
      input.purchaserParentId, input.sourceLearnerId, input.targetLearnerId, input.productId,
      input.effectiveAt, input.resultCode, input.now.toISOString()],
  );
}

async function emitAssignmentEvent(parentId: string, eventType: string, metadata: Record<string, unknown>) {
  await resolveDbClient().run(
    "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
    [randomUUID(), parentId, eventType, JSON.stringify(metadata)],
  );
}

async function recordReassignmentTransition(subscription: Subscription, caseId: string, adminId: string,
  targetLearnerId: string, effectiveAt: string,
  eventType: "reassignment_scheduled" | "reassignment_executed", resultCode: string,
  now: Date, assignmentVersion: number) {
  await insertAssignmentAudit({ subscriptionId: subscription.id, caseId, eventType, actorType: "administrator",
    actorId: adminId, purchaserParentId: subscription.purchaser_parent_id,
    sourceLearnerId: subscription.assigned_learner_id, targetLearnerId,
    productId: subscription.product_id, effectiveAt, resultCode, now });
  await emitAssignmentEvent(subscription.purchaser_parent_id,
    eventType === "reassignment_scheduled" ? "subscription_reassignment_scheduled" : "subscription_assignment_changed",
    { caseId, subscriptionId: subscription.id, sourceLearnerId: subscription.assigned_learner_id,
      targetLearnerId, productId: subscription.product_id, effectiveAt, assignmentVersion });
}

export async function applyDueSubscriptionReassignment(subscriptionId: string, now = new Date()) {
  const db = resolveDbClient();
  const subscription = await db.get<Subscription>("select * from subscriptions where id=?", [subscriptionId]);
  if (!subscription) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  if (!subscription.pending_reassignment_learner_id || !subscription.pending_reassignment_effective_at) {
    return { applied: false, code: "NO_REASSIGNMENT_DUE" };
  }
  if (subscription.pending_reassignment_effective_at > now.toISOString()) {
    return { applied: false, code: "REASSIGNMENT_NOT_DUE" };
  }
  const row = await db.get<ReassignmentCaseRow>(
    `select * from subscription_reassignment_cases where subscription_id=? and status='scheduled'
     and target_learner_id=? and effective_at=? order by requested_at limit 1`,
    [subscription.id, subscription.pending_reassignment_learner_id, subscription.pending_reassignment_effective_at],
  );
  if (!row) throw new BillingAssignmentError("REASSIGNMENT_CASE_REQUIRED");
  await validateReassignment(subscription, subscription.pending_reassignment_learner_id);
  const timestamp = now.toISOString();
  const result = await resolveDbClient().transaction(async (tx) => {
    const changed = (await tx.run(
      `update subscriptions set assigned_learner_id=pending_reassignment_learner_id,
       pending_reassignment_learner_id=null,pending_reassignment_effective_at=null,
       assignment_version=assignment_version+1,version=version+1,updated_at=?
       where id=? and version=? and pending_reassignment_learner_id=?`,
      [timestamp, subscription.id, subscription.version, subscription.pending_reassignment_learner_id],
    )).changes;
    if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
    await tx.run(
      `update subscription_reassignment_cases set status='executed',resolution_code='NEXT_PERIOD_EXECUTED',
       executed_at=?,version=version+1,updated_at=? where id=? and status='scheduled' and version=?`,
      [timestamp, timestamp, row.id, row.version],
    );
    await recordReassignmentTransition(subscription, row.id, row.administrator_id!, row.target_learner_id,
      subscription.pending_reassignment_effective_at!, "reassignment_executed", "NEXT_PERIOD_EXECUTED",
      now, subscription.assignment_version + 1);
    return { applied: true, caseId: row.id, subscriptionId: subscription.id,
      sourceLearnerId: subscription.assigned_learner_id, targetLearnerId: row.target_learner_id,
      effectiveAt: subscription.pending_reassignment_effective_at,
      assignmentVersion: subscription.assignment_version + 1, subscriptionVersion: subscription.version + 1 };
  });
  // EN-003 rules 49-53: audit-only bridge, recorded at the reassignment's
  // own already-existing effective boundary — EN-001/EN-002 already handle
  // the actual access effect (rules 50-53), this only cancels the source
  // learner's own starting reservations for the subscription's app set and
  // folds the event into the shared lifecycle audit ledger (rule 8).
  await applyLifecycleEvent({
    eventId: `reassignment:${row.id}`, eventType: "reassignment_effective", source: "billing_reassignment",
    sourceVersion: result.assignmentVersion, effectiveAt: result.effectiveAt!,
    sourceReference: { reassignmentCaseId: row.id, subscriptionId: subscription.id,
      learnerId: result.sourceLearnerId, reasonCategory: row.reason_code },
    now,
  });
  return result;
}

export async function sweepDueSubscriptionReassignments(now = new Date(), limit = 100) {
  const rows = await resolveDbClient().all<{ id: string }>(
    `select id from subscriptions where pending_reassignment_effective_at is not null
     and pending_reassignment_effective_at<=? order by pending_reassignment_effective_at,id limit ?`,
    [now.toISOString(), Math.min(100, Math.max(1, limit))],
  );
  const results = [];
  for (const row of rows) results.push(await applyDueSubscriptionReassignment(row.id, now));
  return results;
}
