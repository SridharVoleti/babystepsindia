"use client";

import { useRef, useState } from "react";

function money(amount: number | null, currency: string | null) {
  if (amount === null || !currency) return "the displayed subscription price";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amount / 100);
}

export function AutoRenewControl({ subscriptionId, initialEnabled, initialCancelAtPeriodEnd,
  currentPeriodEnd, initialCancellationEffectiveAt, productName, learnerName, expectedAmount,
  currency, expectedVersion }: {
  subscriptionId: string;
  initialEnabled: boolean;
  initialCancelAtPeriodEnd: boolean;
  currentPeriodEnd: string;
  initialCancellationEffectiveAt: string | null;
  productName: string;
  learnerName: string;
  expectedAmount: number | null;
  currency: string | null;
  expectedVersion: number;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [cancelAtEnd, setCancelAtEnd] = useState(initialCancelAtPeriodEnd);
  const [effectiveAt, setEffectiveAt] = useState(initialCancellationEffectiveAt);
  const [version, setVersion] = useState(expectedVersion);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const cancelKey = useRef(crypto.randomUUID());
  const resumeKey = useRef(crypto.randomUUID());

  async function mutate(action: "cancel" | "resume-auto-renew") {
    setPending(true);
    setMessage(null);
    const response = await fetch(`/v1/parent/subscriptions/${subscriptionId}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: version,
        idempotencyKey: action === "cancel" ? cancelKey.current : resumeKey.current }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setMessage(`${action === "cancel" ? "Cancellation" : "Auto-renewal resumption"} could not be completed: ${payload.error}`);
      return;
    }
    setVersion(payload.version);
    if (action === "cancel") {
      setEnabled(false);
      setCancelAtEnd(true);
      setEffectiveAt(payload.cancellationEffectiveAt);
      setMessage(`Cancellation scheduled. ${productName} for ${learnerName} remains available through ${new Date(payload.cancellationEffectiveAt).toLocaleString()}. Progress is preserved.`);
      return;
    }
    if (payload.providerHostedSetupRequired) {
      setSetupUrl(payload.setupUrl);
      setMessage("A provider-hosted recurring-payment setup is required. The subscription remains scheduled to end until Babysteps receives provider confirmation.");
      return;
    }
    setEnabled(true);
    setCancelAtEnd(false);
    setEffectiveAt(null);
    setSetupUrl(null);
    setMessage(`Auto-renewal resumed. The next charge is ${money(payload.expectedAmount, payload.currency)} on ${new Date(payload.nextChargeAt).toLocaleString()}.${payload.lateConfirmationRequired ? " This confirmation replaces the already-passed seven-day reminder." : ""}`);
  }

  return <div className="mt-4 border-t border-chakra-100 pt-4 text-sm">
    <p className="text-chakra-700">Auto-renewal: <strong>{enabled ? "On" : "Off"}</strong></p>
    {cancelAtEnd ? <div className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-900">
      <p><strong>Subscription ends on {new Date(effectiveAt ?? currentPeriodEnd).toLocaleString()}.</strong></p>
      <p className="mt-1">Paid access and existing valid credits continue until then. Progress for {learnerName} is preserved.</p>
    </div> : <div className="mt-2 text-chakra-600">
      <p>Cancel subscription to stop future renewal. Access to {productName} for {learnerName} continues through the paid period ending {new Date(currentPeriodEnd).toLocaleString()}.</p>
      <p className="mt-1">Cancellation does not delete progress or end access immediately.</p>
    </div>}
    {!cancelAtEnd && <button type="button" onClick={() => mutate("cancel")} disabled={pending}
      className="mt-3 min-h-11 rounded-lg border border-chakra-300 px-4 py-2 font-semibold text-chakra-800 disabled:opacity-50">
      {pending ? "Updating…" : "Cancel subscription"}
    </button>}
    {cancelAtEnd && <button type="button" onClick={() => mutate("resume-auto-renew")} disabled={pending}
      className="mt-3 min-h-11 rounded-lg bg-green-700 px-4 py-2 font-semibold text-white disabled:opacity-50">
      {pending ? "Checking recurring payment…" : "Resume auto-renewal"}
    </button>}
    {setupUrl && <p className="mt-3"><a className="font-semibold text-green-700 underline" href={setupUrl}>
      Continue with payment provider</a></p>}
    {message && <p role="status" className="mt-2 text-chakra-700">{message}</p>}
  </div>;
}
