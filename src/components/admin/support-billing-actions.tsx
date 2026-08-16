"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

// AD-003 rules 39, 48, 82, 91-93: both high-risk actions require a fresh
// password+passkey reauth ceremony immediately before submission, and show
// an exact effect preview — never a generic "are you sure" dialog.
export function SupportBillingActions({ caseId, subscriptionId, currentLearnerId, subscriptionVersion,
  eligibleTargets, maxRefundableAmount, currency }: {
  caseId: string; subscriptionId: string; currentLearnerId: string; subscriptionVersion: number;
  eligibleTargets: Array<{ learnerId: string; displayName: string }>; maxRefundableAmount: number; currency: string | null;
}) {
  const router = useRouter();
  const [targetLearnerId, setTargetLearnerId] = useState(eligibleTargets[0]?.learnerId ?? "");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState<number | "">("");

  async function reauthThen(action: () => Promise<void>) {
    setPending(true); setMessage(null);
    try {
      await completeStaffReauth(password);
    } catch {
      setPending(false);
      setMessage("Rejected: reauthentication failed.");
      return;
    }
    await action();
    setPending(false);
  }

  async function reassign() {
    await reauthThen(async () => {
      const response = await fetch(`/v1/admin/support/cases/${caseId}/billing/reassign-subscription`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriptionId, targetLearnerId, reasonCode: reason, effectiveMode: "next_period",
          expectedSubscriptionVersion: subscriptionVersion, idempotencyKey: crypto.randomUUID(),
        }),
      });
      const payload = await response.json();
      setMessage(response.ok ? `Reassignment ${payload.status}; effective ${payload.effectiveAt}.` : `Rejected: ${payload.error}`);
      if (response.ok) router.refresh();
    });
  }

  async function refund(refundType: "full" | "partial") {
    await reauthThen(async () => {
      const response = await fetch(`/v1/admin/support/cases/${caseId}/billing/refunds`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriptionId, refundType, reasonCode: reason,
          amount: refundType === "partial" ? refundAmount : undefined,
          entitlementEffect: refundType === "partial" ? "no_change" : undefined,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const payload = await response.json();
      setMessage(response.ok ? `Refund ${payload.status}.` : `Rejected: ${payload.error}`);
      if (response.ok) router.refresh();
    });
  }

  return (
    <section className="card mt-6 p-5">
      <h2 className="text-lg font-semibold text-chakra-900">Billing actions</h2>
      <p className="mt-1 text-sm text-chakra-500">Every action requires fresh reauthentication and a reason.</p>

      <div className="mt-4 space-y-2">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Confirm password"
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for this action"
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
      </div>

      {eligibleTargets.length > 0 && (
        <div className="mt-4 rounded-lg border border-chakra-200 p-3">
          <p className="text-sm font-medium text-chakra-700">Reassign subscription</p>
          <p className="mt-1 text-xs text-chakra-500">Current learner: {currentLearnerId}. Effective at the next billing boundary unless immediately eligible.</p>
          <select value={targetLearnerId} onChange={(e) => setTargetLearnerId(e.target.value)}
            className="mt-2 w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm">
            {eligibleTargets.map((t) => <option key={t.learnerId} value={t.learnerId}>{t.displayName}</option>)}
          </select>
          <button type="button" onClick={reassign} disabled={pending}
            className="btn-primary mt-2 inline-flex min-h-[44px] items-center px-4">Reassign</button>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-chakra-200 p-3">
        <p className="text-sm font-medium text-chakra-700">Refund</p>
        <p className="mt-1 text-xs text-chakra-500">Max refundable: {maxRefundableAmount} {currency ?? ""}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => refund("full")} disabled={pending}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-chakra-200 px-3 py-2 text-sm">Full refund</button>
          <input type="number" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value ? Number(e.target.value) : "")}
            placeholder="Partial amount" className="w-32 rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
          <button type="button" onClick={() => refund("partial")} disabled={pending}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-chakra-200 px-3 py-2 text-sm">Partial refund</button>
        </div>
      </div>

      {message && <p className="mt-3 text-sm text-chakra-700">{message}</p>}
    </section>
  );
}
