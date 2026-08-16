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

// API-AD-007/API-AD-008: status/role changes for another staff member.
// Business rules 70-73 (self-mutation and last-Platform-Administrator
// protection) are enforced server-side — this form just surfaces whatever
// the API returns.
export function StaffStatusRolesForm({
  staffAccountId,
  currentStatus,
  currentRoleKeys,
  version,
}: {
  staffAccountId: string;
  currentStatus: string;
  currentRoleKeys: string[];
  version: number;
}) {
  const router = useRouter();
  const [roleKeys, setRoleKeys] = useState<string[]>(currentRoleKeys);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toggleRole(key: string) {
    setRoleKeys((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  }

  async function withReauth(action: () => Promise<Response>) {
    if (reason.trim().length < 20) {
      setError("Give a reason of at least 20 characters.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await completeStaffReauth(password);
      const response = await action();
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "failed");
      }
      setPassword("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error && err.message !== "STAFF_REAUTH_FAILED" && err.message !== "failed"
        ? err.message
        : "Could not complete this action. Confirm your password/passkey and try again.");
    } finally {
      setPending(false);
    }
  }

  function submitRoles(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void withReauth(() =>
      fetch(`/v1/admin/staff/${staffAccountId}/roles`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleKeys, reason: reason.trim(), expectedVersion: version, idempotencyKey: crypto.randomUUID() }),
      }));
  }

  function changeStatus(newStatus: "active" | "suspended" | "revoked") {
    void withReauth(() =>
      fetch(`/v1/admin/staff/${staffAccountId}/status`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, reason: reason.trim(), expectedVersion: version, idempotencyKey: crypto.randomUUID() }),
      }));
  }

  return (
    <div className="card space-y-5 p-6">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      <form onSubmit={submitRoles} className="space-y-3">
        <fieldset>
          <legend className="text-sm font-medium text-chakra-900">Roles</legend>
          <div className="mt-2 space-y-2">
            {ROLE_OPTIONS.map((role) => (
              <label key={role.key} className="flex items-center gap-2 text-sm text-chakra-700">
                <input type="checkbox" checked={roleKeys.includes(role.key)} onChange={() => toggleRole(role.key)} />
                {role.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="block text-sm font-medium text-chakra-900" htmlFor="staff-action-reason">
            Reason (visible in the audit log)
          </label>
          <textarea
            id="staff-action-reason"
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
          <label className="block text-sm font-medium text-chakra-900" htmlFor="staff-action-password">
            Confirm your current password
          </label>
          <input
            id="staff-action-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-input mt-1"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <button type="submit" className="btn-primary" disabled={pending}>
            {pending ? "Saving…" : "Save roles"}
          </button>
          {currentStatus !== "revoked" && (
            <>
              {currentStatus === "active" ? (
                <button type="button" className="btn-secondary" disabled={pending} onClick={() => changeStatus("suspended")}>
                  Suspend
                </button>
              ) : (
                <button type="button" className="btn-secondary" disabled={pending} onClick={() => changeStatus("active")}>
                  Reinstate
                </button>
              )}
              <button
                type="button"
                className="btn-secondary text-red-700"
                disabled={pending}
                onClick={() => changeStatus("revoked")}
              >
                Revoke
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-chakra-500">Your passkey will be requested to complete any of these actions.</p>
      </form>
    </div>
  );
}
