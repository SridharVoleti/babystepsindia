"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

const ROLE_OPTIONS = [
  { key: "support_agent", label: "Support Agent" },
  { key: "billing_administrator", label: "Billing Administrator" },
  { key: "operations_administrator", label: "Operations Administrator" },
  { key: "platform_administrator", label: "Platform Administrator" },
];

// API-AD-001: Platform Administrator + recent reauth; idempotent 24h
// invite. Returns the invite link directly in the response (no email
// send wired up in this build) so it can be shared out of band.
export function InviteStaffForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ staffAccountId: string; expiresAt: string } | null>(null);

  function toggleRole(key: string) {
    setRoleKeys((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (roleKeys.length === 0) {
      setError("Choose at least one initial role.");
      return;
    }
    if (reason.trim().length < 20) {
      setError("Give a reason of at least 20 characters.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await completeStaffReauth(password);

      const inviteResponse = await fetch("/v1/admin/staff/invitations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, initialRoleKeys: roleKeys, reason }),
      });
      if (!inviteResponse.ok) throw new Error("invite");
      setResult(await inviteResponse.json());
      router.refresh();
    } catch {
      setError("Could not create the invitation. Confirm your password/passkey and the role selection.");
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return (
      <div className="card space-y-2 p-6">
        <p className="text-sm font-semibold text-chakra-900">Invitation created</p>
        <p className="text-sm text-chakra-600">
          Share this staff account ID with the invitee to accept: <code>{result.staffAccountId}</code>
        </p>
        <p className="text-xs text-chakra-500">Expires {new Date(result.expiresAt).toLocaleString()}.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div>
        <label className="block text-sm font-medium text-chakra-900" htmlFor="invite-email">
          Staff email
        </label>
        <input
          id="invite-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="field-input mt-1"
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-chakra-900">Initial roles</legend>
        <div className="mt-2 space-y-2">
          {ROLE_OPTIONS.map((role) => (
            <label key={role.key} className="flex items-center gap-2 text-sm text-chakra-700">
              <input
                type="checkbox"
                checked={roleKeys.includes(role.key)}
                onChange={() => toggleRole(role.key)}
              />
              {role.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="block text-sm font-medium text-chakra-900" htmlFor="invite-reason">
          Reason (visible in the audit log)
        </label>
        <textarea
          id="invite-reason"
          required
          minLength={20}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="field-input mt-1 w-full"
          rows={2}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-chakra-900" htmlFor="invite-password">
          Confirm your current password
        </label>
        <input
          id="invite-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="field-input mt-1"
        />
      </div>
      <p className="text-xs text-chakra-500">Your passkey will be requested next to complete this confirmation.</p>
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? "Sending invitation…" : "Send invitation"}
      </button>
    </form>
  );
}
