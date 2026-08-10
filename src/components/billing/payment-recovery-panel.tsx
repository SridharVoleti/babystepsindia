"use client";

import { useRef, useState } from "react";

export function PaymentRecoveryPanel({ subscriptionId, paymentState, graceEndsAt, expectedVersion }: {
  subscriptionId: string;
  paymentState: string;
  graceEndsAt: string | null;
  expectedVersion: number;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  if (paymentState === "inactive_nonpayment") return <section className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-950">
    <h3 className="font-semibold">Subscription inactive after unsuccessful payment</h3>
    <p className="mt-1">New learning sessions cannot start. Existing learner progress is safe and remains available.</p>
  </section>;
  if (paymentState !== "past_due_grace" || !graceEndsAt) return null;

  async function updatePaymentMethod() {
    setPending(true); setMessage(null);
    const response = await fetch(`/v1/parent/subscriptions/${subscriptionId}/payment-method-update-session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, idempotencyKey: idempotencyKey.current }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setMessage(`Could not open payment update: ${payload.error}`); return; }
    setMessage("Opening the provider's secure payment-method update page. Updating a method does not itself confirm payment.");
    window.location.assign(payload.updateUrl);
  }

  return <section className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-950">
    <h3 className="font-semibold">Payment unsuccessful — access continues temporarily</h3>
    <p className="mt-1">Existing credits can be used until {new Date(graceEndsAt).toLocaleString()}.</p>
    <p className="mt-1">After that deadline, no new session can start unless payment succeeds. Progress is safe.</p>
    <button type="button" onClick={updatePaymentMethod} disabled={pending}
      className="mt-3 min-h-11 rounded-lg bg-chakra-900 px-4 py-2 font-semibold text-white disabled:opacity-50">
      {pending ? "Opening…" : "Update payment method"}
    </button>
    <p className="mt-2 text-xs">Payment remains unconfirmed until Babysteps receives a verified successful provider event.</p>
    {message && <p role="status" className="mt-2">{message}</p>}
  </section>;
}
