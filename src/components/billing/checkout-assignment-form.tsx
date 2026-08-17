"use client";

import { useRef, useState } from "react";

type LearnerOption = { id: string; displayName: string };
type ProductView = { id: string; name: string; productType: string; version: number; priceInr: number;
  price: { id: string; version: number; amount: number; currency: string; billingInterval: "month" | "year";
    intervalCount: number; supportsNonRenewing: boolean; pricingRuleVersion: string };
  consentDisclosureVersion: string;
  includedApps: { id: string; name: string }[] };

export function CheckoutAssignmentForm({ product, learners, initialLearnerId, privacyConsentRequired }:
  { product: ProductView; learners: LearnerOption[]; initialLearnerId?: string; privacyConsentRequired: boolean }) {
  const preselected = initialLearnerId && learners.some((item) => item.id === initialLearnerId) ? initialLearnerId : undefined;
  const [learnerId, setLearnerId] = useState(preselected ?? learners[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [privacyConsentAccepted, setPrivacyConsentAccepted] = useState(false);
  const [autoRenewEnabled, setAutoRenewEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const learner = learners.find((item) => item.id === learnerId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!learner || !confirmed || (privacyConsentRequired && !privacyConsentAccepted)) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/v1/billing/checkout-intents", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learnerId, productId: product.id, productVersion: product.version,
          priceId: product.price.id, priceVersion: product.price.version, autoRenewEnabled,
          consentDisclosureVersion: product.consentDisclosureVersion,
          privacyConsentAccepted,
          idempotencyKey: idempotencyKey.current }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "CHECKOUT_FAILED");
      setResult(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CHECKOUT_FAILED");
    } finally { setPending(false); }
  }

  if (result) return (
    <div className="card space-y-4 p-6">
      <h2 className="text-lg font-semibold text-chakra-900">Checkout ready</h2>
      <p className="text-sm text-chakra-700">This subscription is for <strong>{result.assignedLearner.displayName}</strong>.</p>
      <p className="text-sm text-chakra-700">Auto-renewal: <strong>{result.autoRenewEnabled ? "On" : "Off"}</strong>.</p>
      <p className="text-sm text-chakra-500">Access is still pending. Returning from the payment page cannot activate it;
        Babysteps waits for verified provider confirmation.</p>
      <a className="btn-primary inline-block" href={result.providerHandoff.url}>Continue to payment provider</a>
    </div>
  );

  return (
    <form onSubmit={submit} className="card space-y-5 p-6">
      <div>
        <label className="field-label" htmlFor="learner">Learner</label>
        <select id="learner" className="field-input" value={learnerId}
          onChange={(event) => { setLearnerId(event.target.value); setConfirmed(false); }} required>
          {learners.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select>
      </div>
      <div className="rounded-lg bg-green-50 p-4 text-sm text-green-900">
        <p className="font-semibold">This subscription is for {learner?.displayName ?? "the selected learner"}.</p>
        <p className="mt-1">{product.name} includes {product.includedApps.map((app) => app.name).join(", ")}.</p>
        <p className="mt-1">{new Intl.NumberFormat("en-IN", { style: "currency", currency: product.price.currency })
          .format(product.price.amount / 100)} every {product.price.intervalCount > 1 ? `${product.price.intervalCount} ` : ""}
          {product.price.billingInterval}{product.price.intervalCount > 1 ? "s" : ""}.</p>
        <p className="mt-1">The first paid period starts only after verified payment. If auto-renewal is on,
          the next charge is one calendar billing interval after activation, using the same billing anchor.</p>
        <p className="mt-1">Learner assignment cannot be changed by the parent after activation.</p>
      </div>
      <label className="block rounded-lg border border-green-200 bg-white p-4 text-sm text-chakra-800">
        <span className="flex items-start gap-3">
          <input aria-label="Automatically renew this subscription" type="checkbox"
            className="mt-1 accent-green-600" checked={autoRenewEnabled}
            disabled={!product.price.supportsNonRenewing}
            onChange={(event) => setAutoRenewEnabled(event.target.checked)} />
          <span><strong>Automatically renew this subscription</strong>
            <span className="mt-1 block text-chakra-600">When selected, you authorize recurring charges of the
              displayed amount on each billing date until you cancel. You can turn renewal off later and keep
              access through the period already paid.</span></span>
        </span>
        {!product.price.supportsNonRenewing && <span className="mt-2 block text-xs text-chakra-500">
          This product is configured for recurring purchase only.</span>}
      </label>
      {privacyConsentRequired && <label className="flex items-start gap-3 rounded-lg border border-green-200 p-4 text-sm text-chakra-700">
        <input aria-label="Accept Babysteps platform privacy consent" type="checkbox" className="mt-1 accent-green-600"
          checked={privacyConsentAccepted} onChange={(event) => setPrivacyConsentAccepted(event.target.checked)} required />
        <span><strong>Babysteps privacy consent</strong>
          <span className="mt-1 block text-chakra-600">I agree to Babysteps using the minimum necessary personal data
            for the approved platform purposes. This one platform-level consent covers Babysteps learning apps and
            will be requested again only if those purposes materially change.</span></span>
      </label>}
      <label className="flex items-start gap-3 text-sm text-chakra-700">
        <input type="checkbox" className="mt-1 accent-green-600" checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)} required />
        <span>I confirm the learner and product shown above.</span>
      </label>
      {error && <p role="alert" className="rounded-lg bg-saffron-50 p-3 text-sm text-saffron-800">{error}</p>}
      <button type="submit" className="btn-primary"
        disabled={pending || !confirmed || !learnerId || (privacyConsentRequired && !privacyConsentAccepted)}>
        {pending ? "Preparing checkout…" : "Continue to payment"}
      </button>
    </form>
  );
}
