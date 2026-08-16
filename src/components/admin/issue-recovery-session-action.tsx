"use client";

import { useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

// AD-005 rules 38-41, 49: a DIFFERENT active Platform Administrator, after
// fresh reauth, issues a 30-minute target-bound recovery enrollment
// session — self-issuance is already blocked server-side (this row is
// simply never rendered for the acting staff member's own account).
export function IssueRecoverySessionAction({ targetStaffId, targetEmail }: { targetStaffId: string; targetEmail: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function issue() {
    setPending(true);
    setMessage(null);
    try {
      await completeStaffReauth(password);
    } catch {
      setPending(false);
      setMessage("Reauthentication failed.");
      return;
    }
    const response = await fetch(`/v1/admin/platform/staff/${targetStaffId}/recovery-sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setMessage(`Rejected: ${body.error}`);
      return;
    }
    setMessage(`Recovery session issued, expires ${new Date(body.expiresAt).toLocaleTimeString()}. Tell ${targetEmail} to visit /staff/recovery.`);
    setPassword("");
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-saffron-700 hover:underline">
        Recover access
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-chakra-200 p-3 text-left">
      <input type="password" placeholder="Your current password" value={password}
        onChange={(e) => setPassword(e.target.value)} className="field-input" autoComplete="current-password" />
      <textarea placeholder="Reason (20-500 characters)" value={reason} onChange={(e) => setReason(e.target.value)} className="field-input" rows={2} />
      <button type="button" onClick={issue} disabled={pending || !password || reason.trim().length < 20}
        className="btn-primary min-h-[44px] px-4">
        {pending ? "Issuing…" : "Issue recovery session"}
      </button>
      {message && <p className="text-xs text-chakra-600">{message}</p>}
    </div>
  );
}
