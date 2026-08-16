"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CHANGE_TYPES = [
  "app_registry_change", "release_promotion", "manual_rollback", "planned_maintenance",
  "emergency_availability_change", "machine_principal_change", "machine_credential_change",
] as const;

// AD-004 rule 20: a change record scopes exactly one change_type/
// environment/optional app before any downstream mutation may reference it.
export function OperationChangeCreateForm() {
  const router = useRouter();
  const [changeType, setChangeType] = useState<(typeof CHANGE_TYPES)[number]>("app_registry_change");
  const [environment, setEnvironment] = useState("production");
  const [appId, setAppId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setMessage(null);
    const response = await fetch("/v1/admin/operations/changes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType, environment, appId: appId.trim() || undefined, reason,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const payload = await response.json();
    setPending(false);
    if (response.ok) {
      router.push(`/admin/operations/changes/${payload.operationChangeId}`);
    } else {
      setMessage(`Rejected: ${payload.error}`);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-semibold text-chakra-900">Start an operation change</h2>
      <p className="mt-1 text-sm text-chakra-500">Every high-impact operation must be scoped here first.</p>

      <div className="mt-4 space-y-2">
        <select value={changeType} onChange={(e) => setChangeType(e.target.value as (typeof CHANGE_TYPES)[number])}
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm">
          {CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm">
          <option value="development">development</option>
          <option value="staging">staging</option>
          <option value="production">production</option>
        </select>
        <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID (optional)"
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
        <textarea value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for this operation (20-500 characters)"
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
      </div>

      <button type="button" onClick={submit} disabled={pending}
        className="btn-primary mt-3 inline-flex min-h-[44px] items-center px-4">
        Create operation change
      </button>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
    </section>
  );
}
