"use client";

import { useRef, useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

type CaseView = {
  caseId: string;
  subscriptionId: string;
  sourceLearnerId: string;
  targetLearnerId: string;
  reasonCode: string;
  version: number;
  subscription: { id: string; version: number; product: { name: string };
    assignedLearner: { displayName: string }; currentPeriodEnd: string };
  eligibility: { valid: boolean; validationCode: string | null; hasUsableLearningOrConsumedCredit: boolean;
    immediateCorrectionAllowed: boolean; nextPeriodEffectiveAt: string };
};

export function AdminReassignmentForm({ assignmentCase }: { assignmentCase: CaseView }) {
  const defaultMode = assignmentCase.eligibility.immediateCorrectionAllowed ? "immediate_if_unused" : "next_period";
  const [effectiveMode, setEffectiveMode] = useState(defaultMode);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await completeStaffReauth(password);
    } catch {
      setPending(false);
      setMessage("Rejected: reauthentication failed.");
      return;
    }
    const response = await fetch(`/v1/admin/subscriptions/${assignmentCase.subscriptionId}/reassign-learner`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        caseId: assignmentCase.caseId, targetLearnerId: assignmentCase.targetLearnerId,
        effectiveMode, reasonCode: assignmentCase.reasonCode,
        expectedSubscriptionVersion: assignmentCase.subscription.version,
        expectedCaseVersion: assignmentCase.version, idempotencyKey: idempotencyKey.current,
      }),
    });
    const payload = await response.json();
    setPending(false);
    setMessage(response.ok ? `Reassignment ${payload.status}; effective ${payload.effectiveAt}.` : `Rejected: ${payload.error}`);
  }

  return (
    <form onSubmit={submit} className="card mt-6 space-y-5 p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div><p className="field-label">Product</p><p>{assignmentCase.subscription.product.name}</p></div>
        <div><p className="field-label">Current learner</p><p>{assignmentCase.subscription.assignedLearner.displayName}</p></div>
        <div><p className="field-label">Source learner ID</p><p className="break-all text-sm">{assignmentCase.sourceLearnerId}</p></div>
        <div><p className="field-label">Target learner ID</p><p className="break-all text-sm">{assignmentCase.targetLearnerId}</p></div>
      </div>
      <div className="rounded-lg bg-chakra-50 p-4 text-sm">
        <p>Validation: {assignmentCase.eligibility.valid ? "Eligible" : assignmentCase.eligibility.validationCode}</p>
        <p>Prior usable learning or consumed credit: {assignmentCase.eligibility.hasUsableLearningOrConsumedCredit ? "Yes" : "No"}</p>
        <p>Next period boundary: {assignmentCase.eligibility.nextPeriodEffectiveAt}</p>
      </div>
      <div><label htmlFor="effectiveMode" className="field-label">Effective rule</label>
        <select id="effectiveMode" className="field-input" value={effectiveMode}
          onChange={(event) => setEffectiveMode(event.target.value)}>
          {assignmentCase.eligibility.immediateCorrectionAllowed &&
            <option value="immediate_if_unused">Immediate — unused assignment only</option>}
          <option value="next_period">Next subscription period</option>
        </select></div>
      <div><label htmlFor="currentPassword" className="field-label">Re-enter your administrator password</label>
        <input id="currentPassword" className="field-input" type="password" autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
      {message && <p role="status" className="text-sm text-chakra-700">{message}</p>}
      <button type="submit" className="btn-primary" disabled={pending || !assignmentCase.eligibility.valid}>
        {pending ? "Applying…" : effectiveMode === "next_period" ? "Schedule reassignment" : "Correct assignment now"}
      </button>
    </form>
  );
}
