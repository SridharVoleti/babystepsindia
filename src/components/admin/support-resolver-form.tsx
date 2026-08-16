"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// AD-002 rules 20, 89: exact-match resolver, visually separate from the
// case queue below it — never a customer browser/search box.
const IDENTIFIER_TYPES = [
  { value: "email", label: "Verified parent email (exact)" },
  { value: "subscription_ref", label: "Subscription reference (exact)" },
  { value: "invoice_ref", label: "Invoice / payment reference (exact)" },
  { value: "case_id", label: "Existing case ID (exact)" },
] as const;

const CATEGORIES = [
  "account_access", "learner_access", "billing_question", "subscription_assignment", "payment_refund",
  "app_access", "progress_display", "technical_issue", "notification_delivery", "other",
] as const;

export function SupportResolverForm() {
  const router = useRouter();
  const [identifierType, setIdentifierType] = useState<(typeof IDENTIFIER_TYPES)[number]["value"]>("email");
  const [identifierValue, setIdentifierValue] = useState("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("account_access");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ receiptId: string; displayName?: string; maskedEmail?: string; accountStatus?: string } | null>(null);

  async function resolve(event: React.FormEvent) {
    event.preventDefault();
    setPending(true); setError(null); setResult(null);
    const response = await fetch("/v1/admin/support/resolve-customer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifierType, identifierValue, reason }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setError(payload.error ?? "RESOLVE_FAILED"); return; }
    if (!payload.matched) { setError("No exact match found."); return; }
    setResult(payload);
  }

  async function createCase() {
    if (!result) return;
    setPending(true); setError(null);
    const response = await fetch("/v1/admin/support/cases", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiptId: result.receiptId, category, reason, idempotencyKey: crypto.randomUUID() }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setError(payload.error ?? "CREATE_FAILED"); return; }
    router.push(`/admin/support/cases/${payload.caseId}`);
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-semibold text-chakra-900">Resolve a customer</h2>
      <p className="mt-1 text-sm text-chakra-500">Exact match only — no name search, no browsing.</p>
      <form onSubmit={resolve} className="mt-4 space-y-3">
        <select value={identifierType} onChange={(e) => setIdentifierType(e.target.value as typeof identifierType)}
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm">
          {IDENTIFIER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input value={identifierValue} onChange={(e) => setIdentifierValue(e.target.value)} placeholder="Exact identifier"
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" required />
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for lookup (20-500 characters)"
          minLength={20} maxLength={500} required className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
        <button type="submit" disabled={pending}
          className="btn-primary inline-flex min-h-[44px] items-center px-4">Resolve</button>
      </form>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {result && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-chakra-900">{result.displayName ?? "Parent"} · {result.maskedEmail} · {result.accountStatus}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}
              className="rounded-lg border border-chakra-200 px-3 py-2 text-sm">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" onClick={createCase} disabled={pending}
              className="btn-primary inline-flex min-h-[44px] items-center px-4">Open case</button>
          </div>
        </div>
      )}
    </section>
  );
}
