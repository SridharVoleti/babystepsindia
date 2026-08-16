"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STATUSES = ["open", "in_progress", "waiting_parent", "escalated", "resolved", "closed"] as const;
const ESCALATION_ROLES = ["billing_administrator", "operations_administrator", "platform_administrator"] as const;

export function SupportCaseActions({ caseId, version, status }: { caseId: string; version: number; status: string }) {
  const router = useRouter();
  const [noteText, setNoteText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addNote(event: React.FormEvent) {
    event.preventDefault();
    setPending(true); setError(null);
    const response = await fetch(`/v1/admin/support/cases/${caseId}/notes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteText, idempotencyKey: crypto.randomUUID() }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setError(payload.error ?? "NOTE_FAILED"); return; }
    setNoteText("");
    router.refresh();
  }

  async function updateStatus(nextStatus: string) {
    setPending(true); setError(null);
    const response = await fetch(`/v1/admin/support/cases/${caseId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: version, idempotencyKey: crypto.randomUUID(), status: nextStatus }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setError(payload.error ?? "UPDATE_FAILED"); return; }
    router.refresh();
  }

  async function escalate(role: string) {
    setPending(true); setError(null);
    const response = await fetch(`/v1/admin/support/cases/${caseId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: version, idempotencyKey: crypto.randomUUID(), status: "escalated", escalationRole: role }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setError(payload.error ?? "ESCALATE_FAILED"); return; }
    router.refresh();
  }

  async function reopen() {
    const reason = prompt("Reason for reopening (20-500 characters):");
    if (!reason) return;
    setPending(true); setError(null);
    const response = await fetch(`/v1/admin/support/cases/${caseId}/reopen`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, idempotencyKey: crypto.randomUUID() }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) { setError(payload.error ?? "REOPEN_FAILED"); return; }
    router.refresh();
  }

  return (
    <section className="card mt-6 p-5">
      <h2 className="text-lg font-semibold text-chakra-900">Case actions</h2>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      <form onSubmit={addNote} className="mt-4 space-y-2">
        <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} minLength={1} maxLength={4000} required
          placeholder="Add an internal note (never passwords, passkeys, or payment details)"
          className="w-full rounded-lg border border-chakra-200 px-3 py-2 text-sm" />
        <button type="submit" disabled={pending} className="btn-primary inline-flex min-h-[44px] items-center px-4">Add note</button>
      </form>

      {status !== "closed" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {STATUSES.filter((s) => s !== status && s !== "escalated").map((s) => (
            <button key={s} type="button" onClick={() => updateStatus(s)} disabled={pending}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-chakra-200 px-3 py-2 text-sm">
              Mark {s}
            </button>
          ))}
        </div>
      )}

      {status !== "closed" && status !== "resolved" && (
        <div className="mt-4">
          <p className="text-sm font-medium text-chakra-700">Escalate to (target role must Continue to act):</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ESCALATION_ROLES.map((role) => (
              <button key={role} type="button" onClick={() => escalate(role)} disabled={pending}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-chakra-200 px-3 py-2 text-sm">
                {role}
              </button>
            ))}
          </div>
        </div>
      )}

      {status === "resolved" && (
        <button type="button" onClick={reopen} disabled={pending}
          className="mt-4 inline-flex min-h-[44px] items-center rounded-lg border border-chakra-200 px-3 py-2 text-sm">
          Reopen case
        </button>
      )}
    </section>
  );
}
