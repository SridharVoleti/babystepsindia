"use client";

import { useState } from "react";
import { clearForeignLauncherCaches } from "@/lib/learner-home/refresh-controller";

export function LearnerModeExitForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/v1/learner-mode/exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword }),
      });
      if (!response.ok) {
        setError("Ask your parent to enter the current account password.");
        return;
      }
      try { clearForeignLauncherCaches(window.sessionStorage); } catch { /* storage may be disabled */ }
      window.location.assign("/account");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 rounded-xl border border-chakra-100 bg-white p-5">
      <h2 className="font-semibold text-chakra-900">Parent area</h2>
      <p className="mt-1 text-sm text-chakra-500">A parent password is required to leave learning mode.</p>
      <label className="mt-4 block text-sm font-medium text-chakra-900" htmlFor="parent-password">
        Parent password
      </label>
      <input id="parent-password" type="password" autoComplete="current-password" required
        value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)}
        className="mt-1 w-full rounded-lg border border-chakra-200 px-3 py-2" />
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <button className="btn-secondary mt-4" type="submit" disabled={pending || !currentPassword}>
        {pending ? "Checking…" : "Return to parent area"}
      </button>
    </form>
  );
}
