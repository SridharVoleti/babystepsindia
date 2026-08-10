"use client";

import { useRef, useState } from "react";

type SubscriptionOption = { id: string; assignedLearner: { id: string; displayName: string };
  product: { name: string }; status: string };
type LearnerOption = { id: string; displayName: string };

export function ReassignmentCaseForm({ subscriptions, learners }: {
  subscriptions: SubscriptionOption[];
  learners: LearnerOption[];
}) {
  const [subscriptionId, setSubscriptionId] = useState(subscriptions[0]?.id ?? "");
  const [targetLearnerId, setTargetLearnerId] = useState("");
  const [reasonCode, setReasonCode] = useState("WRONG_LEARNER_SELECTED");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const selected = subscriptions.find((item) => item.id === subscriptionId);
  const targets = learners.filter((learner) => learner.id !== selected?.assignedLearner.id);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const response = await fetch("/v1/subscription-reassignment-cases", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscriptionId,
        targetLearnerId, reasonCode, notes, idempotencyKey: idempotencyKey.current }) });
    const payload = await response.json();
    setPending(false);
    setMessage(response.ok ? `Case ${payload.caseId} was created. Your learner assignment has not changed.`
      : `Could not create case: ${payload.error}`);
  }

  if (!subscriptions.length || learners.length < 2) return null;
  return (
    <form className="card mt-4 space-y-4 p-6" onSubmit={submit}>
      <h2 className="font-semibold text-chakra-900">Contact Babysteps about learner assignment</h2>
      <p className="text-sm text-chakra-500">Submitting a case does not change access. An authorized billing administrator must review it.</p>
      <div><label htmlFor="subscription" className="field-label">Subscription</label>
        <select id="subscription" className="field-input" value={subscriptionId}
          onChange={(event) => { setSubscriptionId(event.target.value); setTargetLearnerId(""); }}>
          {subscriptions.map((item) => <option key={item.id} value={item.id}>
            {item.product.name} — currently {item.assignedLearner.displayName}</option>)}
        </select></div>
      <div><label htmlFor="targetLearner" className="field-label">Proposed learner</label>
        <select id="targetLearner" className="field-input" value={targetLearnerId}
          onChange={(event) => setTargetLearnerId(event.target.value)} required>
          <option value="">Choose learner</option>
          {targets.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select></div>
      <div><label htmlFor="reasonCode" className="field-label">Reason</label>
        <select id="reasonCode" className="field-input" value={reasonCode}
          onChange={(event) => setReasonCode(event.target.value)}>
          <option value="WRONG_LEARNER_SELECTED">Wrong learner selected</option>
          <option value="LEGITIMATE_ASSIGNMENT_CORRECTION">Legitimate assignment correction</option>
        </select></div>
      <div><label htmlFor="notes" className="field-label">Additional details (optional)</label>
        <textarea id="notes" className="field-input" rows={3} maxLength={1000} value={notes}
          onChange={(event) => setNotes(event.target.value)} /></div>
      {message && <p role="status" className="text-sm text-chakra-700">{message}</p>}
      <button type="submit" className="btn-secondary" disabled={pending || !targetLearnerId}>
        {pending ? "Submitting…" : "Create assignment case"}
      </button>
    </form>
  );
}
