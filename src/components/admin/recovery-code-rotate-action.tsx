"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

// AD-005 rules 67-68: <=10-minute two-factor reauth, invalidates every
// previously unused code, and shows the new set exactly once — never
// retrievable again from this UI afterward.
export function RecoveryCodeRotateAction() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  async function rotate() {
    setPending(true);
    setError(null);
    try {
      await completeStaffReauth(password);
    } catch {
      setPending(false);
      setError("Reauthentication failed.");
      return;
    }
    const response = await fetch("/v1/admin/platform/recovery-codes/rotate", { method: "POST" });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(body.error ?? "Could not rotate recovery codes.");
      return;
    }
    setNewCodes(body.codes);
    setPassword("");
    router.refresh();
  }

  if (newCodes) {
    return (
      <div className="rounded-lg border border-saffron-200 bg-saffron-50 p-4">
        <p className="text-sm font-medium text-saffron-900">
          New recovery codes — shown once, store them offline now:
        </p>
        <ul className="mt-2 space-y-1 font-mono text-sm text-saffron-900">
          {newCodes.map((code) => <li key={code}>{code}</li>)}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="field-label" htmlFor="rotate-password">Current password</label>
        <input id="rotate-password" type="password" autoComplete="current-password" className="field-input"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button type="button" onClick={rotate} disabled={pending || !password}
        className="btn-secondary min-h-[44px] px-4">
        {pending ? "Rotating…" : "Rotate recovery codes"}
      </button>
      {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
    </div>
  );
}
