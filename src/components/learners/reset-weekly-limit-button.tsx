"use client";

import { useState } from "react";

export function ResetWeeklyLimitButton({ learnerId }: { learnerId: string }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");

  async function reset() {
    setState("working");
    try {
      const response = await fetch(`/v1/learners/${learnerId}/reset-weekly-limit`, { method: "POST" });
      setState(response.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <button type="button" onClick={reset} disabled={state === "working"}
      className="inline-flex min-h-[44px] items-center text-sm font-medium text-chakra-500 hover:text-chakra-700 disabled:opacity-50">
      {state === "working" ? "Resetting…" : state === "done" ? "Weekly limit reset" : state === "error" ? "Reset failed — retry" : "Reset weekly limit (testing)"}
    </button>
  );
}
