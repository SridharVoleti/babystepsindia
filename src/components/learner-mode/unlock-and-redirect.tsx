"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createParentModeInvalidationMessage, PARENT_MODE_INVALIDATION_CHANNEL } from "@/lib/parent-shell/mode-guard";

// PD-004: "Open learner" enters learner mode directly — no passkey ceremony.
// AT-PD-004-29: broadcasts the new modeGeneration so any other open /account
// tab revalidates and fails closed rather than sitting on stale parent content.
export function UnlockAndRedirect({ learnerId, learnerName, redirectTo }: {
  learnerId: string; learnerName: string; redirectTo: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const enter = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/v1/learner-mode/enter/direct", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learnerId }),
      });
      if (!response.ok) throw new Error("enter");
      const body = await response.json() as { modeGeneration?: unknown };
      const modeGeneration = typeof body.modeGeneration === "number" ? body.modeGeneration : 0;
      try {
        if (typeof BroadcastChannel !== "undefined") {
          const channel = new BroadcastChannel(PARENT_MODE_INVALIDATION_CHANNEL);
          channel.postMessage(createParentModeInvalidationMessage({
            modeGeneration, reason: "mode_transition", sourceVersion: `learner_mode:${learnerId}`,
          }));
          channel.close();
        }
      } catch { /* BroadcastChannel unavailable — other tabs still fail closed on their own next fetch */ }
      router.push(redirectTo);
    } catch {
      setError(`Could not open ${learnerName}'s profile. Please try again.`);
    }
  }, [learnerId, learnerName, redirectTo, router]);

  useEffect(() => { void enter(); }, [enter]);

  return (
    <div className="mt-4 rounded-xl border border-chakra-100 bg-white p-5">
      {error ? (
        <>
          <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>
          <button className="btn-primary" type="button" onClick={() => void enter()}>Try again</button>
        </>
      ) : (
        <p className="text-sm text-chakra-500">Opening {learnerName}&apos;s profile…</p>
      )}
    </div>
  );
}
